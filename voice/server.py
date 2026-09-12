"""Voice sidecar for the Prep IDE: one local WebSocket that turns mic audio into text and text into speech.

    renderer mic (16 kHz int16 PCM) ──► Silero VAD ─ Smart Turn v3.2 endpointing ─► Parakeet ──► {"type":"final"}
    renderer {"type":"tts","text"}  ──► Edge TTS (en-US-AvaNeural) / Kokoro ──► {"type":"tts_audio",...}

The LLM "brain" is NOT here — it lives in the Electron main process (it sees the question and the editor
buffer, and holds the API keys). This process only does ears and mouth, so it can stay dumb and fast.

Spawned by src/main/services/voiceSidecar.ts with VOICE_PYTHON (a venv with onnxruntime-gpu + torch CUDA).
Prints `VOICE_PORT=<n>` on stdout once listening. Run by hand:  python -u voice/server.py --port 8765

End of turn (ported from voiceAgent/agent/endpoint.py): Silero says "quiet"; after --min-silence ms Smart Turn
v3.2 (models/smart-turn-v3.2-cpu.onnx, ~10 ms on CPU) scores the last 8 s every --check-every ms; the turn
ends when it's confident, or at --max-silence regardless. A mid-confidence score on a trailing filler word
("um", "so", "and") is held, so the model doesn't cut you off mid-hedge.

Protocol (JSON text frames; mic audio is binary little-endian int16 @ 16 kHz mono):
  client → server
    binary                              mic PCM (any frame size; re-chunked to 32 ms here)
    {"type":"mic","on":bool}            start/stop treating audio as speech (off = frames are dropped)
    {"type":"agent_speaking","on":bool} the client is playing TTS: raise the bar for barge-in
    {"type":"tts","id","text","engine","voice"}   synthesise one sentence
    {"type":"tts_cancel"}               drop every pending/in-flight synthesis
  server → client
    {"type":"ready","stt":"parakeet"|"loading"|"none","tts":[...],"detail","turn":"smart-turn"|"silence"}
    {"type":"vad","speaking":bool}      user speech started / stopped (after endpointing)
    {"type":"duck","on":bool}           user probably talking over the agent: lower/restore playback volume
    {"type":"bargein"}                  sustained speech while agent_speaking was on: stop the agent now
    {"type":"partial","text"}           live caption of the utterance so far
    {"type":"final","text","asr_ms","turn":"done"|"timeout"}
    {"type":"tts_audio","id","format":"mp3"|"pcm16_24k","data":<base64>}
    {"type":"tts_end","id"}  {"type":"error","message"}
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import json
import os
import queue
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

SR = 16000
CHUNK = 512  # 32 ms — the frame size Silero VAD is tuned for
HERE = Path(__file__).resolve().parent
SMART_TURN_MODEL = HERE / "models" / "smart-turn-v3.2-cpu.onnx"
HF_HOME_FALLBACK = r"D:\hf-cache\huggingface"

# hedges / conjunctions a finished sentence doesn't end on — hold the turn unless Smart Turn is very confident
FILLER_ENDINGS = {
    "um", "umm", "uh", "uhh", "er", "ah", "so", "and", "but", "or", "the", "a", "is", "that", "that's",
    "like", "because", "which", "yeah", "well", "wait", "if", "i", "you", "we", "it's", "with", "for", "to",
}


def log(msg: str) -> None:
    print(msg, flush=True)


SLOW_MS = float(os.environ.get("VOICE_SLOW_MS", "300"))


class timed:
    """`with timed("partial asr"):` — logs any block slower than SLOW_MS so loop-starving work is visible."""

    def __init__(self, label: str):
        self.label = label

    def __enter__(self):
        self.t0 = time.perf_counter()

    def __exit__(self, *exc):
        ms = (time.perf_counter() - self.t0) * 1e3
        if ms >= SLOW_MS:
            log(f"slow: {self.label} took {ms:.0f} ms")


# ------------------------------------------------------------------ Windows user env (HF cache, tokens)
def load_windows_user_env(names: list[str]) -> None:
    """`setx HF_HOME ...` doesn't reach shells that were already open; read HKCU\\Environment directly so the
    2.4 GB Parakeet model is found in its existing cache instead of re-downloaded to C:."""
    if os.name != "nt":
        return
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            for name in names:
                if os.environ.get(name):
                    continue
                try:
                    value, _ = winreg.QueryValueEx(key, name)
                except FileNotFoundError:
                    continue
                if value:
                    os.environ[name] = str(value)
    except OSError:
        pass
    if not os.environ.get("HF_HOME") and os.path.isdir(HF_HOME_FALLBACK):
        os.environ["HF_HOME"] = HF_HOME_FALLBACK


load_windows_user_env(["HF_HOME", "HF_TOKEN", "HF_HUB_OFFLINE"])


def watch_parent_stdin() -> None:
    """Electron keeps our stdin pipe open for as long as it lives. When it dies (crash, task-kill, the whole
    IDE going down), the pipe hits EOF and we exit too — no orphaned Python holding the GPU."""

    def run() -> None:
        try:
            while sys.stdin.buffer.read(4096):
                pass
        except Exception:  # noqa: BLE001
            pass
        log("parent went away; exiting")
        os._exit(0)

    threading.Thread(target=run, daemon=True).start()


def quiet_onnxruntime() -> None:
    """ORT prints a wall of CUDA-provider warnings on every session; keep only errors in the app log."""
    try:
        import onnxruntime as ort

        ort.set_default_logger_severity(3)
    except Exception:  # noqa: BLE001
        pass


# ------------------------------------------------------------------ STT
class ParakeetSTT:
    """onnx-asr Parakeet TDT. CUDA if onnxruntime has it (or PARAKEET_DEVICE=cpu to force CPU)."""

    def __init__(self, model_name: str, device: str):
        import onnx_asr
        import onnxruntime as ort

        if device == "auto":
            device = "cuda" if "CUDAExecutionProvider" in ort.get_available_providers() else "cpu"
        if device == "cuda":
            if hasattr(ort, "preload_dlls"):
                ort.preload_dlls()
            providers: list[Any] = [("CUDAExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"]
        else:
            providers = ["CPUExecutionProvider"]
        t0 = time.perf_counter()
        self.model = onnx_asr.load_model(model_name, providers=providers)
        self.hybrid = device == "cuda" and self._move_decoder_to_cpu()
        self.model.recognize(np.zeros(SR, dtype=np.float32))  # warm-up (kernel compile / workspace alloc)
        self.load_s = time.perf_counter() - t0
        self.lock = threading.Lock()
        # ORT silently falls back to CPU when the CUDA provider DLLs can't load; report what actually runs.
        active = self._active_providers()
        self.device = ("cuda+cpu-decoder" if self.hybrid else "cuda") if any("CUDA" in p for p in active) else "cpu"
        if device == "cuda" and self.device == "cpu":
            log("warning: CUDA requested but onnxruntime fell back to CPU (needs CUDA 12 + cuDNN 9 DLLs on PATH, "
                "e.g. a venv with onnxruntime-gpu); Parakeet will run slower.")

    def _move_decoder_to_cpu(self) -> bool:
        """The transducer decoder runs once per encoder frame with tiny tensors — launch-bound on GPU.
        Rebuild that one session on CPU (int8 weights when available); the encoder stays on CUDA.
        Ported from voiceAgent/bench/common.py, where this measured ~0.2 ms/frame vs several ms on GPU."""
        try:
            import onnxruntime as ort

            asr = self.model.asr
            sess = getattr(asr, "_decoder_joint", None)
            if sess is None:
                return False
            path = Path(sess._model_path)
            int8 = path.with_name(path.name.replace(".onnx", ".int8.onnx"))
            if not int8.exists():
                try:
                    from huggingface_hub import hf_hub_download

                    int8 = Path(hf_hub_download("istupakov/parakeet-tdt-0.6b-v3-onnx", int8.name))
                except Exception:  # noqa: BLE001
                    int8 = path
            so = ort.SessionOptions()
            so.inter_op_num_threads = 1
            asr._decoder_joint = ort.InferenceSession(str(int8), sess_options=so, providers=["CPUExecutionProvider"])
            asr._decoder_joint_path = str(int8)
            return True
        except Exception as e:  # noqa: BLE001
            log(f"hybrid decoder unavailable ({type(e).__name__}: {str(e)[:120]}); decoder stays on GPU")
            return False

    def _active_providers(self) -> set[str]:
        import onnxruntime as ort

        seen: set[str] = set()
        stack, visited = [self.model], set()
        while stack:
            obj = stack.pop()
            if id(obj) in visited:
                continue
            visited.add(id(obj))
            if isinstance(obj, ort.InferenceSession):
                seen.update(obj.get_providers())
                continue
            for attr in getattr(obj, "__dict__", {}).values():
                if hasattr(attr, "__dict__") or isinstance(attr, ort.InferenceSession):
                    stack.append(attr)
        return seen

    def recognize(self, audio: np.ndarray) -> str:
        with self.lock:
            out = self.model.recognize(audio)
        return (out.text if hasattr(out, "text") else str(out)).strip()


# ------------------------------------------------------------------ end of turn
class SmartTurn:
    """Pipecat Smart Turn v3.2: p(turn complete) from the last 8 s of audio. ~10 ms on CPU."""

    WIN = 8 * SR

    def __init__(self, path: Path = SMART_TURN_MODEL):
        import onnxruntime as ort

        sys.path.insert(0, str(HERE / "models"))
        from whisper_features import compute_whisper_log_mel_features

        self._features = compute_whisper_log_mel_features
        so = ort.SessionOptions()
        so.inter_op_num_threads = 1
        so.intra_op_num_threads = 4
        self.sess = ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])
        self(np.zeros(SR, dtype=np.float32))  # warm

    def __call__(self, audio: np.ndarray) -> float:
        a = audio[-self.WIN:] if len(audio) > self.WIN else np.pad(audio, (self.WIN - len(audio), 0))
        feats = self._features(a.astype(np.float32), do_normalize=True)
        out = self.sess.run(None, {"input_features": feats[None].astype(np.float32)})
        return float(np.asarray(out[0]).reshape(-1)[0])


class Endpointer:
    """None | "done" | "timeout" per chunk while the user is silent. Degrades to a plain hangover without the model."""

    def __init__(self, min_ms: int, max_ms: int, every_ms: int, threshold: float, high_threshold: float, model: SmartTurn | None):
        self.min_ms, self.max_ms, self.every_ms = min_ms, max_ms, every_ms
        self.threshold, self.high_threshold, self.model = threshold, high_threshold, model
        self.last_check_ms = -1e9
        self.last_p: float | None = None

    def start_utterance(self) -> None:
        self.last_check_ms = -1e9
        self.last_p = None

    def update(self, audio: np.ndarray, silence_ms: float, trailing_text: str) -> str | None:
        if silence_ms < self.min_ms:
            return None
        if silence_ms >= self.max_ms:
            return "timeout"
        if self.model is None or silence_ms - self.last_check_ms < self.every_ms:
            return None
        self.last_check_ms = silence_ms
        with timed("smart turn"):
            p = self.model(audio)
        self.last_p = p
        if p < self.threshold:
            return None
        if p >= self.high_threshold:
            return "done"
        words = re.findall(r"[a-z']+", trailing_text.lower())
        if words and words[-1] in FILLER_ENDINGS:
            return None
        return "done"


# ------------------------------------------------------------------ TTS engines
async def edge_tts_mp3(text: str, voice: str) -> bytes:
    import edge_tts

    chunks: list[bytes] = []
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


class KokoroEngine:
    """Local Kokoro-82M (optional). float32 24 kHz out; sent to the client as int16 PCM."""

    def __init__(self, voice: str = "af_heart"):
        import torch
        from kokoro import KModel, KPipeline

        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = KModel(repo_id="hexgrad/Kokoro-82M").to(device).eval()
        self.pipelines: dict[str, Any] = {}
        self.voice = voice
        self.lock = threading.Lock()
        self.synth("Warm up.")

    def _pipeline(self, voice: str):
        from kokoro import KPipeline

        lang = voice[0]
        if lang not in self.pipelines:
            self.pipelines[lang] = KPipeline(lang_code=lang, model=self.model, repo_id="hexgrad/Kokoro-82M")
        return self.pipelines[lang]

    def synth(self, text: str, voice: str | None = None) -> bytes:
        import torch

        v = voice or self.voice
        with self.lock, torch.inference_mode():
            parts = [r.audio.detach().float().cpu().numpy() for r in self._pipeline(v)(text, voice=v) if r.audio is not None]
        audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return (np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes()


# ------------------------------------------------------------------ the session
class VoiceSession:
    """One connected client. Mic frames go to a VAD/endpointing thread; results come back through an
    asyncio queue so the websocket loop can send them without touching torch/onnx from the loop thread."""

    def __init__(self, ws, loop: asyncio.AbstractEventLoop, server: "Server"):
        self.ws = ws
        self.loop = loop
        self.server = server
        self.a = server.a
        self.out: asyncio.Queue = asyncio.Queue()
        self.pcm_q: queue.Queue = queue.Queue()
        self.mic_on = False
        self.agent_speaking = False
        self.tts_gen = 0  # bumped by tts_cancel: anything synthesised for an older generation is dropped
        self.closed = False

    def emit(self, msg: dict) -> None:
        self.loop.call_soon_threadsafe(self.out.put_nowait, msg)

    # -- mic thread: VAD + endpointing + ASR
    def mic_worker(self) -> None:
        import torch
        from silero_vad import load_silero_vad

        vad = load_silero_vad()
        a = self.a
        ep = Endpointer(a.min_silence, a.max_silence, a.check_every, a.turn_threshold, a.turn_high_threshold,
                        self.server.smart_turn)
        preroll: collections.deque = collections.deque(maxlen=int(a.preroll * SR / CHUNK) + 1)
        pending = np.zeros(0, dtype=np.float32)
        utt: list[np.ndarray] = []
        speaking = False
        t_on = t_last = 0.0
        hot = 0        # leaky accumulator of net sustained-speech credit while the agent may be barged in on
        miss_run = 0   # consecutive below-threshold chunks since the last hit, once ducked
        ducked = False
        last_partial_len = 0
        partial_busy = threading.Event()
        last_partial_text = ""

        def partial_job(audio: np.ndarray) -> None:
            nonlocal last_partial_text
            try:
                stt = self.server.stt
                if stt is not None:
                    # Captions only need the recent tail; a shorter window keeps partials cheap on long turns.
                    with timed(f"partial asr ({len(audio) / SR:.0f}s utt)"):
                        text = stt.recognize(audio[-SR * self.a.partial_window:])
                    if text:
                        last_partial_text = text
                        self.emit({"type": "partial", "text": text})
            finally:
                partial_busy.clear()

        def finish_utterance(reason: str) -> None:
            nonlocal speaking, hot, utt, last_partial_text
            speaking, hot = False, 0
            audio = np.concatenate(utt)
            utt = []
            preroll.clear()
            vad.reset_states()
            self.emit({"type": "vad", "speaking": False})
            if (t_last - t_on) * 1e3 < a.min_speech:
                return
            stt = self.server.stt
            if stt is None:
                self.emit({"type": "error", "message": "Speech detected but the speech-to-text model isn't loaded yet."})
                return
            t0 = time.perf_counter()
            with timed(f"final asr ({len(audio) / SR:.0f}s utt)"):
                text = stt.recognize(audio)
            asr_ms = (time.perf_counter() - t0) * 1e3
            last_partial_text = ""
            if text:
                self.emit({"type": "final", "text": text, "asr_ms": round(asr_ms), "turn": reason,
                           "turn_p": None if ep.last_p is None else round(ep.last_p, 2)})

        while not self.closed:
            try:
                item = self.pcm_q.get(timeout=0.2)
            except queue.Empty:
                continue
            if item is None:
                return
            pending = np.concatenate([pending, item])
            while len(pending) >= CHUNK:
                chunk, pending = pending[:CHUNK], pending[CHUNK:]
                if not self.mic_on:
                    continue
                now = time.perf_counter()
                with timed("silero vad"):
                    p = vad(torch.from_numpy(chunk), SR).item()
                if not speaking:
                    preroll.append(chunk)
                    if not self.agent_speaking:
                        hot, miss_run, ducked = 0, 0, False
                        if p >= a.threshold:
                            speaking, t_on, t_last = True, now, now
                            utt = list(preroll)
                            last_partial_len = 0
                            ep.start_utterance()
                            self.emit({"type": "vad", "speaking": True})
                        continue
                    # Two-stage barge-in while the agent talks (ported from voiceAgent/agent/talk.py): speech credit
                    # accumulates per hit and only leaks --bargein-decay per miss, so a natural 32 ms VAD dip doesn't
                    # reset it. At --duck-chunks the playback is ducked (a backchannel "mhm" passes and the volume
                    # comes back); at --bargein-chunks the agent is cut and the utterance is captured.
                    if p >= a.bargein_threshold:
                        miss_run = 0
                        hot = min(hot + 1, a.bargein_chunks + a.duck_chunks)
                        if hot >= a.duck_chunks and not ducked:
                            ducked = True
                            self.emit({"type": "duck", "on": True})
                        if hot >= a.bargein_chunks:
                            hot, miss_run, ducked = 0, 0, False
                            self.emit({"type": "bargein"})
                            speaking, t_on, t_last = True, now, now
                            utt = list(preroll)
                            last_partial_len = 0
                            ep.start_utterance()
                            self.emit({"type": "vad", "speaking": True})
                    else:
                        hot = max(0, hot - a.bargein_decay)
                        if ducked:
                            miss_run += 1
                            if miss_run >= a.bargein_release_chunks:
                                ducked, hot, miss_run = False, 0, 0
                                self.emit({"type": "duck", "on": False})
                    continue

                utt.append(chunk)
                if p >= a.threshold:
                    t_last = now
                total = len(utt) * CHUNK
                if self.server.stt is not None and total - last_partial_len >= int(a.partial_every * SR) and not partial_busy.is_set():
                    last_partial_len = total
                    partial_busy.set()
                    threading.Thread(target=partial_job, args=(np.concatenate(utt),), daemon=True).start()
                sil_ms = (now - t_last) * 1e3
                decision = ep.update(np.concatenate(utt), sil_ms, last_partial_text) if sil_ms >= ep.min_ms else None
                if decision or (now - t_on) >= a.max_utt:
                    finish_utterance(decision or "timeout")

    # -- loop side
    async def handle_text(self, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        t = msg.get("type")
        if t == "mic":
            self.mic_on = bool(msg.get("on"))
        elif t == "agent_speaking":
            self.agent_speaking = bool(msg.get("on"))
        elif t == "tts_cancel":
            self.tts_gen += 1
        elif t == "tts":
            asyncio.create_task(self.synth(msg, self.tts_gen))

    async def synth(self, msg: dict, gen: int) -> None:
        tid, text = str(msg.get("id", "")), str(msg.get("text", "")).strip()
        engine, voice = msg.get("engine", "edge"), msg.get("voice") or "en-US-AvaNeural"
        if not text:
            await self.out.put({"type": "tts_end", "id": tid})
            return
        try:
            if engine == "kokoro":
                kokoro = await self.loop.run_in_executor(None, self.server.kokoro)
                data = await self.loop.run_in_executor(None, kokoro.synth, text, voice if voice[:1] in "ab" else None)
                fmt = "pcm16_24k"
            else:
                data = await edge_tts_mp3(text, voice)
                fmt = "mp3"
        except Exception as e:  # noqa: BLE001
            await self.out.put({"type": "error", "message": f"TTS failed ({engine}): {type(e).__name__}: {str(e)[:200]}"})
            await self.out.put({"type": "tts_end", "id": tid})
            return
        if gen != self.tts_gen:  # cancelled while synthesising (barge-in)
            return
        await self.out.put({"type": "tts_audio", "id": tid, "format": fmt, "data": base64.b64encode(data).decode("ascii")})
        await self.out.put({"type": "tts_end", "id": tid})


# ------------------------------------------------------------------ server
class Server:
    def __init__(self, args):
        self.a = args
        self.stt: ParakeetSTT | None = None
        self.stt_state = "loading" if not args.no_stt else "none"
        self.stt_detail = ""
        self.smart_turn: SmartTurn | None = None
        self._kokoro: KokoroEngine | None = None
        self._kokoro_lock = threading.Lock()
        self.sessions: set[VoiceSession] = set()

    def kokoro(self) -> KokoroEngine:
        with self._kokoro_lock:
            if self._kokoro is None:
                log("loading Kokoro…")
                self._kokoro = KokoroEngine()
            return self._kokoro

    def load_models(self) -> None:
        if self.a.smart_turn and SMART_TURN_MODEL.exists():
            try:
                self.smart_turn = SmartTurn()
                log("smart turn: loaded")
            except Exception as e:  # noqa: BLE001
                log(f"smart turn unavailable ({type(e).__name__}: {str(e)[:120]}); using silence-only endpointing")
        try:
            log(f"loading {self.a.model} ({self.a.device})…")
            self.stt = ParakeetSTT(self.a.model, self.a.device)
            self.stt_state = "parakeet"
            self.stt_detail = f"{self.a.model} on {self.stt.device}, loaded in {self.stt.load_s:.1f}s"
        except Exception as e:  # noqa: BLE001
            self.stt_state = "none"
            self.stt_detail = f"STT unavailable: {type(e).__name__}: {str(e)[:300]}"
        log(f"stt: {self.stt_state} — {self.stt_detail}")
        for s in list(self.sessions):
            s.emit(self.ready_msg())

    def ready_msg(self) -> dict:
        return {"type": "ready", "stt": self.stt_state, "tts": ["edge", "kokoro"], "detail": self.stt_detail,
                "turn": "smart-turn" if self.smart_turn else "silence"}

    async def handler(self, ws) -> None:
        loop = asyncio.get_running_loop()
        sess = VoiceSession(ws, loop, self)
        self.sessions.add(sess)
        threading.Thread(target=sess.mic_worker, daemon=True).start()
        await ws.send(json.dumps(self.ready_msg()))
        log("client connected")

        async def sender() -> None:
            while True:
                msg = await sess.out.get()
                await ws.send(json.dumps(msg))

        send_task = asyncio.create_task(sender())
        try:
            async for frame in ws:
                if isinstance(frame, bytes):
                    if len(frame) >= 2:
                        sess.pcm_q.put(np.frombuffer(frame, dtype="<i2").astype(np.float32) / 32768.0)
                else:
                    await sess.handle_text(frame)
        except Exception as e:  # noqa: BLE001
            log(f"client error: {type(e).__name__}: {e}")
        finally:
            sess.closed = True
            sess.pcm_q.put(None)
            send_task.cancel()
            self.sessions.discard(sess)
            log("client disconnected")

    async def health(self, connection, request):
        """Plain HTTP GET /health on the same port, for readiness checks."""
        if request.path == "/health":
            return connection.respond(200, json.dumps({"ok": True, "stt": self.stt_state}))
        return None

    async def warm_edge(self) -> None:
        """First Edge TTS call pays DNS/TLS setup (~2-3 s); later ones are ~150 ms. Pay it before anyone speaks."""
        try:
            t0 = time.perf_counter()
            await edge_tts_mp3("Ready.", "en-US-AvaNeural")
            log(f"edge tts: warm ({(time.perf_counter() - t0) * 1e3:.0f} ms)")
        except Exception as e:  # noqa: BLE001
            log(f"edge tts warm-up failed (offline?): {type(e).__name__}: {str(e)[:120]}")

    async def run(self) -> None:
        import websockets

        if not self.a.no_stt:
            threading.Thread(target=self.load_models, daemon=True).start()
        asyncio.create_task(self.warm_edge())
        # ping_timeout is generous: a burst of GIL-heavy work (model load, long ASR) must not drop the client.
        async with websockets.serve(self.handler, "127.0.0.1", self.a.port, process_request=self.health,
                                    max_size=8 * 1024 * 1024, ping_interval=20, ping_timeout=60) as server:
            port = next(iter(server.sockets)).getsockname()[1]
            log(f"VOICE_PORT={port}")
            await asyncio.Future()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0, help="0 = pick a free port (reported as VOICE_PORT=)")
    ap.add_argument("--model", default=os.environ.get("PARAKEET_MODEL", "nemo-parakeet-tdt-0.6b-v3"))
    ap.add_argument("--device", default=os.environ.get("PARAKEET_DEVICE", "auto"), choices=["auto", "cuda", "cpu"])
    ap.add_argument("--no-stt", action="store_true", help="TTS only (no Parakeet)")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--bargein-threshold", type=float, default=0.6,
                    help="VAD score that counts as the user talking over the agent (echo cancellation attenuates you, so lower than --threshold would be too eager, higher misses you)")
    ap.add_argument("--bargein-chunks", type=int, default=10, help="net 32 ms speech credits to cut the agent (10 ≈ 320 ms)")
    ap.add_argument("--duck-chunks", type=int, default=3, help="net credits before the agent's volume is ducked (3 ≈ 96 ms)")
    ap.add_argument("--bargein-decay", type=int, default=1, help="credits lost per below-threshold chunk (1 = a brief dip barely costs anything)")
    ap.add_argument("--bargein-release-chunks", type=int, default=6, help="consecutive quiet chunks after ducking before the volume is restored (≈190 ms)")
    ap.add_argument("--smart-turn", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--min-silence", type=int, default=350, help="ms of silence before Smart Turn starts scoring")
    ap.add_argument("--max-silence", type=int, default=1500, help="ms of silence that ends the turn regardless (thinking pauses while coding run long)")
    ap.add_argument("--check-every", type=int, default=200)
    ap.add_argument("--turn-threshold", type=float, default=0.7)
    ap.add_argument("--turn-high-threshold", type=float, default=0.9)
    ap.add_argument("--min-speech", type=int, default=250)
    ap.add_argument("--preroll", type=float, default=0.6)
    ap.add_argument("--max-utt", type=float, default=30.0)
    ap.add_argument("--partial-every", type=float, default=0.8, help="seconds of new audio between live captions")
    ap.add_argument("--partial-window", type=int, default=10, help="seconds of utterance tail transcribed for a caption")
    args = ap.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    quiet_onnxruntime()
    if os.environ.get("PREP_PARENT_WATCH") == "1":
        watch_parent_stdin()
    try:
        asyncio.run(Server(args).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
