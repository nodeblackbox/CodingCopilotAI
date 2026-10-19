"""Smoke test for voice/server.py without a microphone or the Electron app.

    py -3 voice/test_client.py --port 8765 [--wav path/to/utterance.wav] [--expect "what was said"]

1. TTS: asks for one sentence in Ava's voice (Edge), checks that mp3 bytes come back. Kokoro is tried
   too but only reported (it's optional and needs its own compatible torch/numpy).
2. STT round trip: streams a 16 kHz wav in as if it were the microphone and checks Parakeet's transcript.
   Without --wav it looks for a recorded utterance in $PREP_TEST_AUDIO (default voice/test_audio) (with its reference transcript),
   and failing that synthesises one with Windows' built-in SAPI voice via PowerShell.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np

SAPI_PHRASE = "What is the time complexity of a hash map lookup?"
VOICE_AGENT_AUDIO = Path(os.environ.get("PREP_TEST_AUDIO", "")) if os.environ.get("PREP_TEST_AUDIO") else Path(__file__).resolve().parent / "test_audio"


def load_wav_16k(path: Path) -> np.ndarray:
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    data = data.mean(axis=1)
    if sr != 16000:
        n = int(len(data) * 16000 / sr)
        data = np.interp(np.linspace(0, len(data) - 1, n), np.arange(len(data)), data).astype(np.float32)
    return data


def find_utterance(wav: str | None, expect: str | None) -> tuple[np.ndarray, str, str]:
    """Returns (audio16k, reference_text, source_label)."""
    if wav:
        return load_wav_16k(Path(wav)), expect or "", wav
    ref_path = VOICE_AGENT_AUDIO / "handy_reference.json"
    if ref_path.exists():
        ref = json.loads(ref_path.read_text(encoding="utf-8"))
        for name, text in ref.items():
            p = VOICE_AGENT_AUDIO / name
            if p.exists() and text:
                return load_wav_16k(p), text, str(p)
    if os.name == "nt":
        out = Path(tempfile.gettempdir()) / "prep_sapi_test.wav"
        ps = (
            "Add-Type -AssemblyName System.Speech; "
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            f"$s.SetOutputToWaveFile('{out}'); $s.Speak('{SAPI_PHRASE}'); $s.Dispose()"
        )
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, capture_output=True)
        return load_wav_16k(out), SAPI_PHRASE, f"SAPI → {out}"
    raise SystemExit("no test utterance: pass --wav")


async def recv_until(ws, want: set[str], timeout: float) -> list[dict]:
    got: list[dict] = []
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.perf_counter()))
        except asyncio.TimeoutError:
            break
        msg = json.loads(raw)
        got.append(msg)
        if msg.get("type") in want:
            break
    return got


def norm(s: str) -> list[str]:
    return "".join(c for c in s.lower() if c.isalnum() or c == " ").split()


async def main(a) -> int:
    import websockets

    failures = 0

    def check(label: str, ok: bool, detail: str = "", soft: bool = False) -> None:
        nonlocal failures
        tag = "PASS" if ok else ("WARN" if soft else "FAIL")
        print(f"{tag}  {label}{'  — ' + detail if detail else ''}")
        failures += 0 if (ok or soft) else 1

    # ping_interval=None: the Electron renderer never pings, so don't let a busy server fail this test on keepalives
    async with websockets.connect(f"ws://127.0.0.1:{a.port}", max_size=8 * 1024 * 1024, ping_interval=None) as ws:
        ready = json.loads(await ws.recv())
        check("server sends ready", ready.get("type") == "ready", f"stt={ready.get('stt')} {ready.get('detail', '')[:90]}")

        # 1. Edge TTS (Ava) — two sentences, to see warm vs cold latency
        for i, text in enumerate(["Hi, I'm Ava. Let's work through this problem together.", "Start with a hash map."]):
            t0 = time.perf_counter()
            await ws.send(json.dumps({"type": "tts", "id": f"e{i}", "text": text, "engine": "edge", "voice": "en-US-AvaNeural"}))
            msgs = await recv_until(ws, {"tts_end"}, 20)
            audio = [m for m in msgs if m.get("type") == "tts_audio"]
            errs = [m["message"] for m in msgs if m.get("type") == "error"]
            n_bytes = sum(len(base64.b64decode(m["data"])) for m in audio)
            check(f"Edge TTS sentence {i + 1} returned mp3", bool(audio) and n_bytes > 2000,
                  f"{n_bytes} bytes in {(time.perf_counter() - t0) * 1e3:.0f} ms" + (f" · {errs}" if errs else ""))

        # optional: Kokoro
        t0 = time.perf_counter()
        await ws.send(json.dumps({"type": "tts", "id": "k1", "text": "Kokoro check.", "engine": "kokoro", "voice": "af_heart"}))
        msgs = await recv_until(ws, {"tts_end"}, 180)
        pcm = [m for m in msgs if m.get("type") == "tts_audio"]
        errs = [m["message"] for m in msgs if m.get("type") == "error"]
        check("Kokoro (optional) returned pcm16", bool(pcm), f"{(time.perf_counter() - t0) * 1e3:.0f} ms" + (f" · {errs[0][:160]}" if errs else ""), soft=True)

        if a.skip_stt:
            return failures

        stt = ready.get("stt")
        deadline = time.perf_counter() + 240
        while stt == "loading" and time.perf_counter() < deadline:
            for m in await recv_until(ws, {"ready"}, 5):
                if m.get("type") == "ready":
                    stt = m.get("stt")
                    print(f"      stt now: {stt} — {m.get('detail', '')[:100]}")
        check("Parakeet loaded", stt == "parakeet", str(stt))
        if stt != "parakeet":
            return failures

        # 2. wav → "microphone" → VAD → Parakeet
        audio16, reference, source = find_utterance(a.wav, a.expect)
        print(f"      utterance: {source} ({len(audio16) / 16000:.1f}s)")
        stream = np.concatenate([np.zeros(8000, dtype=np.float32), audio16, np.zeros(24000, dtype=np.float32)])
        pcm16 = (np.clip(stream, -1, 1) * 32767).astype("<i2").tobytes()
        await ws.send(json.dumps({"type": "mic", "on": True}))
        t0 = time.perf_counter()
        # Read concurrently while sending, like a real client: otherwise partials fill the receive queue,
        # the socket stops being read, keepalive pings go unanswered and the server drops us.
        msgs: list[dict] = []

        async def reader() -> None:
            async for raw in ws:
                msgs.append(json.loads(raw))

        reader_task = asyncio.create_task(reader())
        frame = 2 * 1024  # 64 ms of int16 per frame, paced at real time like a microphone
        t_begin = time.perf_counter()
        for n, i in enumerate(range(0, len(pcm16), frame)):
            await ws.send(pcm16[i:i + frame])
            await asyncio.sleep(max(0.0, t_begin + (n + 1) * 0.064 - time.perf_counter()))
        # A long ramble is legitimately several turns; wait for the trailing silence to close the last one.
        await asyncio.sleep(4.0)
        reader_task.cancel()
        finals = [m for m in msgs if m.get("type") == "final"]
        partials = [m for m in msgs if m.get("type") == "partial"]
        check("VAD detected speech", any(m.get("type") == "vad" and m.get("speaking") for m in msgs))
        text = " ".join(f["text"] for f in finals)  # Smart Turn may split a long ramble into several turns
        if finals:
            print(f"      {len(finals)} turn(s): " + " | ".join(f"{f.get('turn')} p={f.get('turn_p')} asr {f.get('asr_ms')}ms" for f in finals))
        if reference:
            overlap = len(set(norm(text)) & set(norm(reference))) / max(1, len(set(norm(reference))))
            ok = bool(finals) and overlap >= 0.6
            detail = f"heard: {text!r} · expected: {reference[:80]!r} · word overlap {overlap:.0%}"
        else:
            ok, detail = bool(text), f"heard: {text!r}"
        check("Parakeet transcribed the utterance", ok,
              f"{detail} · {len(partials)} partials · {(time.perf_counter() - t0) * 1e3:.0f} ms total")

    return failures


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--wav", default=None, help="16 kHz-ish mono wav to use as the fake microphone")
    ap.add_argument("--expect", default=None, help="what the wav says (for the overlap check)")
    ap.add_argument("--skip-stt", action="store_true")
    n = asyncio.run(main(ap.parse_args()))
    print("\nALL PASSED" if n == 0 else f"\n{n} FAILED")
    raise SystemExit(0 if n == 0 else 1)
