import type { Question } from '@shared/types'

/**
 * Seeded question bank. Every entry has a Python starter (signature + a `__main__` sanity check so Run
 * prints something), and the first one keeps the brute-force body so the Optimize chip has work to do.
 */

const py = (lines: string[]): string => lines.join('\n')

export const QUESTIONS: Question[] = [
  {
    id: 'two-sum',
    title: 'Two Sum',
    index: 1,
    category: 'Arrays & Hashing',
    difficulty: 'Easy',
    topics: ['Array', 'Hash Table'],
    prompt:
      "Given an array of integers nums and an integer target, return the indices of the two numbers that add up to target. Each input has exactly one valid answer, and you can't use the same element twice.",
    examples: [
      { heading: 'Example 1', lines: ['Input: nums = [2,7,11,15], target = 9', 'Output: [0,1]', 'Explanation: nums[0] + nums[1] == 9.'] },
      { heading: 'Example 2', lines: ['Input: nums = [3,2,4], target = 6', 'Output: [1,2]'] }
    ],
    constraints: ['2 ≤ nums.length ≤ 10⁴', '-10⁹ ≤ nums[i] ≤ 10⁹', 'Only one valid answer exists'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def twoSum(self, nums: list[int], target: int) -> list[int]:',
        '        for i in range(len(nums)):',
        '            for j in range(i + 1, len(nums)):',
        '                if nums[i] + nums[j] == target:',
        '                    return [i, j]',
        '        return []',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().twoSum([2, 7, 11, 15], 9))'
      ]),
      javascript: py([
        'function twoSum(nums, target) {',
        '  for (let i = 0; i < nums.length; i++) {',
        '    for (let j = i + 1; j < nums.length; j++) {',
        '      if (nums[i] + nums[j] === target) return [i, j];',
        '    }',
        '  }',
        '  return [];',
        '}',
        '',
        'console.log(twoSum([2, 7, 11, 15], 9));'
      ])
    },
    status: 'attempted'
  },
  {
    id: 'contains-duplicate',
    title: 'Contains Duplicate',
    index: 217,
    category: 'Arrays & Hashing',
    difficulty: 'Easy',
    topics: ['Array', 'Hash Table', 'Sorting'],
    prompt: 'Given an integer array nums, return true if any value appears at least twice in the array, and false if every element is distinct.',
    examples: [
      { heading: 'Example 1', lines: ['Input: nums = [1,2,3,1]', 'Output: true'] },
      { heading: 'Example 2', lines: ['Input: nums = [1,2,3,4]', 'Output: false'] }
    ],
    constraints: ['1 ≤ nums.length ≤ 10⁵', '-10⁹ ≤ nums[i] ≤ 10⁹'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def containsDuplicate(self, nums: list[int]) -> bool:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().containsDuplicate([1, 2, 3, 1]))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'valid-anagram',
    title: 'Valid Anagram',
    index: 242,
    category: 'Arrays & Hashing',
    difficulty: 'Easy',
    topics: ['Hash Table', 'String', 'Sorting'],
    prompt: 'Given two strings s and t, return true if t is an anagram of s, and false otherwise. An anagram uses all the original letters exactly once.',
    examples: [
      { heading: 'Example 1', lines: ['Input: s = "anagram", t = "nagaram"', 'Output: true'] },
      { heading: 'Example 2', lines: ['Input: s = "rat", t = "car"', 'Output: false'] }
    ],
    constraints: ['1 ≤ s.length, t.length ≤ 5 · 10⁴', 's and t consist of lowercase English letters'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def isAnagram(self, s: str, t: str) -> bool:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().isAnagram("anagram", "nagaram"))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'group-anagrams',
    title: 'Group Anagrams',
    index: 49,
    category: 'Arrays & Hashing',
    difficulty: 'Medium',
    topics: ['Array', 'Hash Table', 'String'],
    prompt: 'Given an array of strings strs, group the anagrams together. You can return the answer in any order.',
    examples: [
      { heading: 'Example 1', lines: ['Input: strs = ["eat","tea","tan","ate","nat","bat"]', 'Output: [["bat"],["nat","tan"],["ate","eat","tea"]]'] },
      { heading: 'Example 2', lines: ['Input: strs = [""]', 'Output: [[""]]'] }
    ],
    constraints: ['1 ≤ strs.length ≤ 10⁴', '0 ≤ strs[i].length ≤ 100', 'strs[i] consists of lowercase English letters'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def groupAnagrams(self, strs: list[str]) -> list[list[str]]:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().groupAnagrams(["eat", "tea", "tan", "ate", "nat", "bat"]))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'top-k-frequent',
    title: 'Top K Frequent Elements',
    index: 347,
    category: 'Arrays & Hashing',
    difficulty: 'Medium',
    topics: ['Array', 'Hash Table', 'Heap', 'Bucket Sort'],
    prompt: 'Given an integer array nums and an integer k, return the k most frequent elements. You may return the answer in any order.',
    examples: [
      { heading: 'Example 1', lines: ['Input: nums = [1,1,1,2,2,3], k = 2', 'Output: [1,2]'] },
      { heading: 'Example 2', lines: ['Input: nums = [1], k = 1', 'Output: [1]'] }
    ],
    constraints: ['1 ≤ nums.length ≤ 10⁵', 'k is in the range [1, number of unique elements]', 'The answer is guaranteed to be unique'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def topKFrequent(self, nums: list[int], k: int) -> list[int]:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().topKFrequent([1, 1, 1, 2, 2, 3], 2))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'product-except-self',
    title: 'Product of Array Except Self',
    index: 238,
    category: 'Arrays & Hashing',
    difficulty: 'Medium',
    topics: ['Array', 'Prefix Sum'],
    prompt: 'Given an integer array nums, return an array answer such that answer[i] is the product of all the elements of nums except nums[i]. You must do it in O(n) without using the division operation.',
    examples: [
      { heading: 'Example 1', lines: ['Input: nums = [1,2,3,4]', 'Output: [24,12,8,6]'] },
      { heading: 'Example 2', lines: ['Input: nums = [-1,1,0,-3,3]', 'Output: [0,0,9,0,0]'] }
    ],
    constraints: ['2 ≤ nums.length ≤ 10⁵', '-30 ≤ nums[i] ≤ 30', 'The product of any prefix or suffix fits in a 32-bit integer'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def productExceptSelf(self, nums: list[int]) -> list[int]:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().productExceptSelf([1, 2, 3, 4]))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'valid-parentheses',
    title: 'Valid Parentheses',
    index: 20,
    category: 'Stack',
    difficulty: 'Easy',
    topics: ['Stack', 'String'],
    prompt: "Given a string s containing just the characters '(', ')', '{', '}', '[' and ']', determine if the input string is valid: open brackets must be closed by the same type of bracket, in the correct order, and every close bracket has a corresponding open bracket.",
    examples: [
      { heading: 'Example 1', lines: ['Input: s = "()[]{}"', 'Output: true'] },
      { heading: 'Example 2', lines: ['Input: s = "(]"', 'Output: false'] }
    ],
    constraints: ['1 ≤ s.length ≤ 10⁴', "s consists of parentheses only '()[]{}'"],
    starterCode: {
      python: py([
        'class Solution:',
        '    def isValid(self, s: str) -> bool:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().isValid("()[]{}"))'
      ])
    },
    status: 'attempted'
  },
  {
    id: 'best-time-stock',
    title: 'Best Time to Buy and Sell Stock',
    index: 121,
    category: 'Sliding Window',
    difficulty: 'Easy',
    topics: ['Array', 'Dynamic Programming'],
    prompt: 'You are given an array prices where prices[i] is the price of a given stock on the ith day. Choose a single day to buy and a later day to sell. Return the maximum profit you can achieve; if no profit is possible, return 0.',
    examples: [
      { heading: 'Example 1', lines: ['Input: prices = [7,1,5,3,6,4]', 'Output: 5', 'Explanation: Buy on day 2 (price 1), sell on day 5 (price 6).'] },
      { heading: 'Example 2', lines: ['Input: prices = [7,6,4,3,1]', 'Output: 0'] }
    ],
    constraints: ['1 ≤ prices.length ≤ 10⁵', '0 ≤ prices[i] ≤ 10⁴'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def maxProfit(self, prices: list[int]) -> int:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().maxProfit([7, 1, 5, 3, 6, 4]))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'longest-substring',
    title: 'Longest Substring Without Repeating Characters',
    index: 3,
    category: 'Sliding Window',
    difficulty: 'Medium',
    topics: ['String', 'Sliding Window', 'Hash Table'],
    prompt: 'Given a string s, find the length of the longest substring without repeating characters.',
    examples: [
      { heading: 'Example 1', lines: ['Input: s = "abcabcbb"', 'Output: 3', 'Explanation: The answer is "abc".'] },
      { heading: 'Example 2', lines: ['Input: s = "pwwkew"', 'Output: 3'] }
    ],
    constraints: ['0 ≤ s.length ≤ 5 · 10⁴', 's consists of English letters, digits, symbols and spaces'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def lengthOfLongestSubstring(self, s: str) -> int:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().lengthOfLongestSubstring("abcabcbb"))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'binary-search',
    title: 'Binary Search',
    index: 704,
    category: 'Binary Search',
    difficulty: 'Easy',
    topics: ['Array', 'Binary Search'],
    prompt: 'Given a sorted (ascending) integer array nums and an integer target, return the index of target if it exists, otherwise return -1. Your algorithm must run in O(log n).',
    examples: [
      { heading: 'Example 1', lines: ['Input: nums = [-1,0,3,5,9,12], target = 9', 'Output: 4'] },
      { heading: 'Example 2', lines: ['Input: nums = [-1,0,3,5,9,12], target = 2', 'Output: -1'] }
    ],
    constraints: ['1 ≤ nums.length ≤ 10⁴', 'All the integers in nums are unique', 'nums is sorted in ascending order'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def search(self, nums: list[int], target: int) -> int:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().search([-1, 0, 3, 5, 9, 12], 9))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'merge-intervals',
    title: 'Merge Intervals',
    index: 56,
    category: 'Intervals',
    difficulty: 'Medium',
    topics: ['Array', 'Sorting'],
    prompt: 'Given an array of intervals where intervals[i] = [start_i, end_i], merge all overlapping intervals and return an array of the non-overlapping intervals that cover all the intervals in the input.',
    examples: [
      { heading: 'Example 1', lines: ['Input: intervals = [[1,3],[2,6],[8,10],[15,18]]', 'Output: [[1,6],[8,10],[15,18]]'] },
      { heading: 'Example 2', lines: ['Input: intervals = [[1,4],[4,5]]', 'Output: [[1,5]]'] }
    ],
    constraints: ['1 ≤ intervals.length ≤ 10⁴', 'intervals[i].length == 2', '0 ≤ start_i ≤ end_i ≤ 10⁴'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def merge(self, intervals: list[list[int]]) -> list[list[int]]:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().merge([[1, 3], [2, 6], [8, 10], [15, 18]]))'
      ])
    },
    status: 'attempted'
  },
  {
    id: 'maximum-subarray',
    title: 'Maximum Subarray',
    index: 53,
    category: 'Dynamic Programming',
    difficulty: 'Medium',
    topics: ['Array', 'Dynamic Programming', 'Divide and Conquer'],
    prompt: 'Given an integer array nums, find the subarray with the largest sum, and return its sum.',
    examples: [
      { heading: 'Example 1', lines: ['Input: nums = [-2,1,-3,4,-1,2,1,-5,4]', 'Output: 6', 'Explanation: The subarray [4,-1,2,1] has the largest sum 6.'] },
      { heading: 'Example 2', lines: ['Input: nums = [5,4,-1,7,8]', 'Output: 23'] }
    ],
    constraints: ['1 ≤ nums.length ≤ 10⁵', '-10⁴ ≤ nums[i] ≤ 10⁴'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def maxSubArray(self, nums: list[int]) -> int:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().maxSubArray([-2, 1, -3, 4, -1, 2, 1, -5, 4]))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'climbing-stairs',
    title: 'Climbing Stairs',
    index: 70,
    category: 'Dynamic Programming',
    difficulty: 'Easy',
    topics: ['Dynamic Programming', 'Math', 'Memoization'],
    prompt: 'You are climbing a staircase. It takes n steps to reach the top. Each time you can either climb 1 or 2 steps. In how many distinct ways can you climb to the top?',
    examples: [
      { heading: 'Example 1', lines: ['Input: n = 2', 'Output: 2', 'Explanation: 1+1 or 2.'] },
      { heading: 'Example 2', lines: ['Input: n = 3', 'Output: 3'] }
    ],
    constraints: ['1 ≤ n ≤ 45'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def climbStairs(self, n: int) -> int:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().climbStairs(5))'
      ])
    },
    status: 'not_started'
  },
  {
    id: 'median-two-sorted',
    title: 'Median of Two Sorted Arrays',
    index: 4,
    category: 'Binary Search',
    difficulty: 'Hard',
    topics: ['Array', 'Binary Search', 'Divide and Conquer'],
    prompt: 'Given two sorted arrays nums1 and nums2 of size m and n respectively, return the median of the two sorted arrays. The overall run time complexity should be O(log (m+n)).',
    examples: [
      { heading: 'Example 1', lines: ['Input: nums1 = [1,3], nums2 = [2]', 'Output: 2.0'] },
      { heading: 'Example 2', lines: ['Input: nums1 = [1,2], nums2 = [3,4]', 'Output: 2.5'] }
    ],
    constraints: ['0 ≤ m, n ≤ 1000', '1 ≤ m + n ≤ 2000', '-10⁶ ≤ nums1[i], nums2[i] ≤ 10⁶'],
    starterCode: {
      python: py([
        'class Solution:',
        '    def findMedianSortedArrays(self, nums1: list[int], nums2: list[int]) -> float:',
        '        pass',
        '',
        '',
        'if __name__ == "__main__":',
        '    print(Solution().findMedianSortedArrays([1, 3], [2]))'
      ])
    },
    status: 'not_started'
  }
]

export const LIBRARY_STATUS_LABEL: Record<Question['status'], string> = {
  solved: 'Solved',
  attempted: 'Attempted',
  not_started: 'Not started'
}

export function questionById(id: string | null | undefined): Question | undefined {
  return QUESTIONS.find((q) => q.id === id)
}

/** Generic fallback so a language without a starter still has a signature to work from. */
export function starterFor(question: Question, language: string): string {
  return question.starterCode[language] ?? question.starterCode.python ?? ''
}
