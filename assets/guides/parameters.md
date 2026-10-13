# Parameters, syntax, and cost-aware iteration

> Evidence provenance: dated settings, billing checks, and image comparisons below are retained upstream historical observations. Public prompting documentation was rechecked on 2026-10-02; current presets, schemas, and live account checks govern supported requests. Historical showcase settings are not universal optima.

This guide separates documented NovelAI behavior from this plugin's request and cost controls. Use the live tool schema as the authority for accepted field names, enumerations, and server-enforced limits. Guides cannot establish that an account has a particular entitlement. For editing and reference workflows, also read [advanced.md](advanced.md).

## A practical first request

Use one image at a normal size, the selected model's supported default sampler/schedule, modest guidance, and an explicit seed for comparisons. V5's current documented default is 23 steps; the Opus free maximum is 28. The general guidance page recommends approximately 5–6 for V3 and newer. The current frontend and many V5 quickstarts use 7; that establishes an implementation/showcase starting value, not a controlled finding that 7 is better. Choose guidance by the visual result rather than calling one default optimal.

This plugin currently defaults to **23 steps for all four models**, **scale 7 for V5 / 5 for V4.5**, 832×1216, `k_euler_ancestral`, `karras`, `cfg_rescale: 0`, standard quality, heavy UC, and no Variety Boost. V5 only accepts Karras here. V4.5 quality presets are standard/none; light quality is V5-only. Explicit 28-step V4.5 examples are permitted test choices, not a statement of the default. The request preview is the authoritative effective payload, including any model-specific preset expansion.

## Automatic presets, like the website

The server automatically adds the selected quality suffix and negative-content template; the caller does not need to paste their text. Start with the defaults when suitable. `nai_get_presets(model=...)` returns every available template in full for that exact model, and `nai_quote` with `offline:true` shows the final compiled text.

| Model | Quality choices | Negative choices | Defaults |
|---|---|---|---|
| V5 Full / Curated | `standard`, `light`, `none` | `heavy`, `light`, `humanFocus`, `furryFocus`, `none` | `standard` + `heavy` |
| V4.5 Full | `standard`, `none` | `heavy`, `light`, `humanFocus`, `furryFocus`, `none` | `standard` + `heavy` |
| V4.5 Curated | `standard`, `none` | `heavy`, `light`, `humanFocus`, `none` | `standard` + `heavy` |

Unsupported combinations such as V4.5 light quality or V4.5 Curated furryFocus are rejected. Template names do not imply identical text across models: the compiler uses each model's own definitions. Your `negative_prompt` adds to the selected template; clearing it does not disable automatic negatives. Choose `none` explicitly to disable a template, not as a blanket recommendation for every image.

Following the inspected official frontend behavior, a selected nonempty UC preset on a Full model additionally prepends `nsfw` when the effective positive prompt does not contain that term. It is part of the effective negative text, not a separate moderation or age guarantee. `none` has no template prefix. Inspect the compiled result rather than relying on the preset label alone.

When `text` or a supported manual `Text:` block is supplied, the compiler puts lettering last and removes `no text` from its automatic quality suffix. It cannot infer the intent of every conflicting term the user manually typed. V4.5 Curated standard quality still includes `-0.8::feet::`; when feet are missing or distorted, inspect this term and compare a custom suffix without it if warranted. Full-body requests do not inherently require disabling the standard preset. For most unrelated subjects this is not a reason to disable all defaults.

For comparison, the upstream-inspected [official V5 interaction example 0120](https://static.novelai.net/quickstart/v5/0120.webp) used 23 steps, `k_euler_ancestral`, `karras`, and scale 7. This is a historical showcase configuration, not an exhaustive parameter study or a gender-specific optimum. Changing guidance should be a deliberate experiment.

In the 2026-09-20 local test, CFG 5 versus 7 used three seeds each on V5 Full and Curated with the same rainy-street/umbrella prompt. Prop placement, hair and hand readability had mixed outcomes. This does not justify replacing the default with a universal winner. Preserve the prompt and seed when comparing guidance for a specific failure.

| Field | Meaning and useful choices |
|---|---|
| `model` | One of the four supported exact IDs; model changes affect the whole rendering |
| `prompt` | Base positive prompt; scene/style/count plus any solo character details |
| `negative_prompt` | Additional undesired content; not ordinary logical negation |
| `characters` | Separate character descriptions, optional UC, and optional normalized positions using the tool schema |
| `width`, `height` | Framing and pixel budget; use supported multiples and aspect ratios |
| `steps` | Refinement iterations; more is not always better and costs more V5 allowance |
| `scale` | Prompt guidance; increasing can improve compliance but also harden edges/colors |
| `seed` | Repeatability aid; hold constant when testing prompt changes |
| `quality_preset` | Adds model-specific positive tags; `none` lets you control them directly |
| `negative_preset` | Adds a model-specific negative list; use `none` for intentional styles it suppresses |
| `sampler`, `noise_schedule` | Change the denoising path; use a supported pairing, not a sampler copied from an old SD workflow |
| `cfg_rescale` | Guidance rescaling; leave at the supported default unless diagnosing oversaturation |
| `variety_boost` | Model-dependent extension; this plugin exposes it only where supported, not as a V5 feature |
| `text` | When provided by this plugin, literal lettering appended after the scene description; omit a manual `Text:` block |

Normal canvas examples are 832×1216 portrait, 1216×832 landscape, and 1024×1024 square. The first two contain 1,011,712 pixels; a 1024-square is 1,048,576. A dimension larger than 1024 on one side is not automatically paid if the total pixel count remains eligible. Conversely, 1024×1536 is above the free normal pixel budget. Use an optional quote or account check when that information is needed.

V4.5 position controls correspond to a 5×5 grid. A practical normalized mapping uses centers 0.1, 0.3, 0.5, 0.7, 0.9 on each axis if confirmed by the tool; accept the validator's actual constraint. V5 positioning is more flexible. Position is not a precise skeletal pose.

The generic official sampling page still explains older SMEA/SMEA DYN behavior. That is not evidence that every described sampler or SMEA flag is supported by V5 or V4.5. Use supported defaults and reject unsupported combinations. Do not enable legacy SMEA flags merely because the generic page recommends them for older high-resolution models.

## Zero Anlas does not mean no limits

The official free Opus envelope is an eligible single image, normal pixel budget, at most 28 steps. Batch generation costs Anlas even if the individual size looks eligible. Account tier and current privileges still matter. Do not infer Opus from the user's word "subscribed."

V5 adds a rechargeable allowance for otherwise free generations. As of the 2026-09-19 FAQ:

- Current default estimates use 23 steps at approximately one megapixel.
- Roughly 17 generations consume 1% of the bar; a full bar represents roughly 1,730 such images.
- Published monthly estimate is about 7,000 images under those assumptions, not an unconditional quota.
- Refill is continuous, approximately 11% per day in the initial period and 14% per day on continued subscriptions; renewal is not an immediate refill.
- Resolution and step count both affect drawdown. Exhausting the allowance makes otherwise free V5 generation consume Anlas.
- V4.5 and older models keep the ordinary unlimited eligible Opus generations.

Treat these as human-facing approximations. Do not reconstruct a supposedly authoritative billing algorithm from them. Use live account/limit data when needed; generation does not automatically run a cost guard. Anlas balances are a different pool from V5 free allowance. **There is no 5% minimum.** For V5, a fresh `usage.isNegative: false` can permit otherwise eligible free generation even when the displayed `percent` is 0. A rounded bar percentage is not the exhaustion signal. Negative or unavailable usage must be considered in the quote and paid authorization rather than assumed free.

The quota tool preserves raw `v5_usage` and adds `v5_usage_summary`. Official image OpenAPI defines `timeUntilNextPercent` as seconds to gain one percentage point from the current level (for example 1.4% to 2.4%), not time to the next whole-number mark. The summary exposes this duration and derived percentage points per day without estimating a guaranteed image count.

Generation follows the user's request and approval; this guide grants neither. Paid sizes, steps, edits and references are supported workflows. Existing approval need not be requested repeatedly. `nai_quote` is optional cost information rather than a required generation step. The remote server can charge Anlas, and unknown cost is not evidence of zero cost.

Generation does not automatically reserve a budget, poll balances or pause for billing reconciliation. Use `nai_check_credits` when the user needs account information. Never manually retry a timeout whose POST outcome is unknown; it may already have completed remotely.

Reference features have separate costs: the docs list a 2-Anlas fee to encode a V4+ vibe (re-encoding at another information setting costs again), 2 Anlas per extra vibe above four, and 5 Anlas per Precise Reference per generation. They are not implicit extensions of free text-to-image. Precise Reference is documented for V4.5, not V5, and is incompatible with Vibe Transfer at present.

## Prompt compilation matters

Some things shown in the website are client transformations, not syntax the raw image endpoint is guaranteed to perform:

- Quality/UC toggles expand to actual text.
- `!macro:Name!` expands a saved browser/account chunk.
- `||choice A|choice B||` resolves a randomizer; the same seed does not fix the chosen text.
- `base | character 1 | character 2` is a website shorthand for character prompts on newer models; it is not the old prompt-mixing meaning.

For a portable workflow, use fully expanded text and structured `characters`. Resolve random choices before the request and record the actual selection. This lets another harness reproduce what was sent.

The plugin normalizes supported model/sampler aliases and aligns valid in-range dimensions to multiples of 64. Explicit dimensions outside 64-4096 and incompatible settings such as V5 Variety Boost, V4.5 native transparency, or a non-Karras V5 schedule are not silently corrected: offline validation rejects them. Check the returned `resolved_request` before submission.

Optional offline `nai_quote` returns `resolved_request` with the actual preview seed; reuse it for generation if the preview must be reproduced. Leaving `seed` omitted in a fresh request chooses another seed. Validation also flags some exact plain-tag conflicts with effective global UC and manual `no text`; these are conservative text diagnostics, not a parser for every weighted/prose construction or predictions of image quality. They never remove the user's words or change presets automatically.

To reuse an earlier image, prefer its original operation receipt via `nai_image_info` with `action:"recover"`. It compares effective payloads and full input-file hashes, including pixels outside a focused crop. An original PNG can provide a draft, but missing source/mask/reference files are not invented and ambiguous Full/Curated identity is not guessed. Expanded image prompts use `none` presets to avoid double injection; active flags or unknown metadata may require review. Recovery never generates. After an unknown timeout, inspect the existing receipt with `nai_image_info` using `action:"operation"`; do not manually retry the POST. A local `submitted` state does not prove the remote outcome.

Avoid the historical `Prompt1|Prompt2:0.3` mixing syntax: official Prompt Mixing is only for V3 and lower. Likewise `(keyword:1.2)` is not the documented NovelAI numerical weighting syntax.

## Correct emphasis

```text
{important detail}             one 1.05× boost
{{important detail}}           1.1025×
[less important detail]        divide by 1.05
1.2::important detail::        explicit 1.2× span
0.7::subtle detail::            explicit weaker span
-1::hat::                      targeted negative concept, V4.5/V5
```

Everything after an opening numerical weight stays in its span until a closing `::`. An unclosed span accidentally weights the scene, quality suffix, or text. Balanced bracketing or a closing `::` also prevents macros from leaking weights into subsequent content.

In UC, stronger means more avoidance. `{beard}` in UC suppresses beards more strongly; it does not enhance beards. Do not add negated sentences such as "not without a beard" when `beard` or a visible positive description is clearer.

## Lettering

Use exactly one representation:

1. A normal scene `prompt` plus the plugin's literal `text` field, or
2. A manually composed prompt with a final `Text:` block, if the tool accepts that form.

Everything after `Text:` is potential lettering. Quality suffixes must precede it, and the `no text` quality tag must be removed. Multiple text blocks are separated with an empty line. V5 Full supports up to 750 characters, V5 Curated 374, and V4.5 118 according to the dedicated text-rendering page, including spaces and line breaks.

Use short text for the first test. Inspect the actual letters and placement. Setting a field successfully is not a claim that the image contains the requested text without errors.

## Pick the right experiment

| Problem | Useful experiment |
|---|---|
| The image is vague or composition wrong | Clarify action, shot, and visual hierarchy before changing settings |
| A key detail is missing | Check conflicts; moderately weight that detail; keep the seed fixed |
| Colors are harsh | Lower guidance or examine supported rescale behavior; avoid changing prompt, seed, and sampler simultaneously |
| The frame is too crowded | Remove unnecessary subjects/props or choose a wider normal canvas |
| An illustration looks generic | Specify a medium/palette/light relationship and test lighter/no quality preset |
| A generated hand fails | Simplify contact geometry, state support/grip clearly, then compare |
| Text is absent | Remove `no text` and text-suppressing UC; verify the final text section |
| Everything is almost identical | Check fixed seed or unintended base-image references; use a new seed after controlled tests |

Save effective prompts, quality and negative expansions, dimensions, model, seed, steps, scale, sampler/schedule, and character positions. The original model and sampler can still have nondeterminism; matching a seed alone does not guarantee identical pixels, and NovelAI seeds do not match ordinary Stable Diffusion seeds.

## Use the matching operation

`nai_generate_image` is the text-to-image entrypoint. Image-to-image, inpainting, enhancement, upscaling, Director transformations, encoding, and reference-based generation use their corresponding tools; do not paste unsupported image fields into a text-only request. Read [advanced.md](advanced.md) for selection, preservation limits, and source/mask/reference preparation. Use each tool's live schema and `nai_quote` for its supported settings and estimated cost. UI history and canvas operations are not prerequisites for a portable API client; save source files, derivatives, and metadata locally.
