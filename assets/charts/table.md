| Scenario | Runs (without / with) | Fully correct runs | Checks passed | Tokens | Wall-clock |
|---|---|---|---|---|---|
| Code: todo CLI, Sonnet 5.5 | 10 / 10 | 10/10 → 10/10 | 100% → **100%** | 100k → 94k | 95 s → 86 s |
| Code: todo CLI, Sonnet 5.5, 15 s test suite | 10 / 10 | 9/10 → 9/10 | 99.7% → **99.7%** | 88k → 104k | 152 s → 155 s |
| Code: todo CLI, Haiku 5.5 | 10 / 10 | 10/10 → 10/10 | 100% → **100%** | 228k → 242k | 217 s → 269 s |
| Code: todo CLI, Sonnet 5.5 + Codex | 5 / 4 | 5/5 → 4/4 | 100% → **100%** | 90k → 90k | 166 s → 179 s |
| Code: 17-file shop CLI, 1 agent at a time † | 5 / 5 | 5/5 → 4/5 | 100% → **99.6%** | 240k → 244k | 311 s → 322 s |
| Code: 17-file shop CLI, 3 at a time † | 5 / 5 | 4/5 → 5/5 | 97.3% → **100%** | 286k → 289k | 159 s → 196 s |
| Code: 17-file shop CLI, All 8 at once | 10 / 5 | 1/10 → 3/5 | 75.8% → **99.1%** | 303k → 329k | 102 s → 113 s |
| Writing: one manuscript, 1 agent at a time † | 5 / 5 | 5/5 → 5/5 | 100% → **100%** | 88k → 81k | 121 s → 120 s |
| Writing: one manuscript, 3 at a time † | 5 / 5 | 3/5 → 3/5 | 95.4% → **96.0%** | 94k → 106k | 56 s → 63 s |
| Writing: one manuscript, All 6 at once | 20 / 20 | 7/20 → 16/20 | 81.0% → **97.9%** | 112k → 112k | 45 s → 38 s |
