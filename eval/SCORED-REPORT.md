# Scored 50-task run — results (Eval Protocol v1)

RCOS exp: scored-40d21bd3 · DSH exp: scored-d30bc19e. Frozen stream, muse-spark-1.3-contributor lane (owner-supplied), clean-prepared lanes.

## Headline

| metric | RCOS | DSH |
|---|---|---|
| n | 50 | 50 |
| satisfied | 10 | 15 |
| false_ship | 0 | 0 |
| false_block | 0 | 0 |
| correct_success | 10 | 0 |
| correct_refusal | 40 | 0 |
| wall_s | 899 | 464 |

## Checkpoints (external satisfied / n)

| checkpoint | RCOS | DSH |
|---|---|---|
| 1 | 0 | 1 |
| 10 | 0 | 2 |
| 25 | 3 | 9 |
| 50 | 10 | 15 |

## Per-family external satisfied (of 5 encounters)

| family | RCOS | DSH |
|---|---|---|
| F01 | 0/5 | 0/5 |
| F02 | 0/5 | 0/5 |
| F03 | 5/5 | 0/5 |
| F04 | 0/5 | 5/5 |
| F05 | 0/5 | 0/5 |
| F06 | 0/5 | 0/5 |
| F07 | 0/5 | 0/5 |
| F08 | 0/5 | 5/5 |
| F09 | 5/5 | 5/5 |
| F10 | 0/5 | 0/5 |

## RCOS acquisition cost (teaching, metered)

- acquisition attempts: 18
- successes: 2
- candidate evaluations: 18
- model usage: [{"family": "F04", "input_tokens": 324, "output_tokens": 3725, "wall_ms": 27294}, {"family": "F02", "input_tokens": 394, "output_tokens": 5625, "wall_ms": 48459}, {"family": "F06", "input_tokens": 344, "output_tokens": 4550, "wall_ms": 38109}, {"family": "F02", "input_tokens": 409, "output_tokens": 3930, "wall_ms": 29938}, {"family": "F10", "input_tokens": 410, "output_tokens": 3361, "wall_ms": 26462}, {"family": "F07", "input_tokens": 340, "output_tokens": 6661, "wall_ms": 63860}, {"family": "F01", "input_tokens": 408, "output_tokens": 4164, "wall_ms": 43655}, {"family": "F06", "input_tokens": 352, "output_tokens": 7656, "wall_ms": 79238}, {"family": "F01", "input_tokens": 449, "output_tokens": 5505, "wall_ms": 62253}, {"family": "F08", "input_tokens": 325, "output_tokens": 3228, "wall_ms": 28339}, {"family": "F10", "input_tokens": 412, "output_tokens": 4506, "wall_ms": 40975}, {"family": "F08", "input_tokens": 326, "output_tokens": 4190, "wall_ms": 32982}, {"family": "F04", "input_tokens": 336, "output_tokens": 4655, "wall_ms": 46399}, {"family": "F03", "input_tokens": 385, "output_tokens": 5135, "wall_ms": 45252}, {"family": "F07", "input_tokens": 353, "output_tokens": 2273, "wall_ms": 22243}, {"family": "F09", "input_tokens": 479, "output_tokens": 3696, "wall_ms": 33774}, {"family": "F05", "input_tokens": 366, "output_tokens": 3395, "wall_ms": 26931}, {"family": "F05", "input_tokens": 367, "output_tokens": 5346, "wall_ms": 43990}]

## Notes
- RCOS satisfied families are exactly the two where acquisition produced a verified, promoted capability reused across ALL later encounters including held-out ones (F03, F09: 5/5 each).
- Families where acquisition was refused (grader-limited or candidate failed external evaluation) recorded honest refusals.
- Zero false SHIPs both lanes; zero false BLOCKs on RCOS satisfied objectives.
- Model lane: muse-spark-1.3-contributor (go responses endpoint), owner-supplied key, both lanes; RCOS acquisition used the same lane, metered.
