# Shared prompting core

Use this core for any gender, creatures, scenery, objects, and AI planning. It grants no generation permission. Facts and practical suggestions are separated in [sources.md](sources.md); full topics are read only when needed.

## Preserve the brief

Keep the requested subject, style, model, and scope. A fragment or local edit need not become a complete scene. Do not add people to scenery or products, invent gender or age, or turn an illustration into photography. Tags, natural language, and mixtures are supported; a clear short tag prompt needs no mandatory prose paragraph. Ordinary descriptions are not thereby verified dataset tags.

Choose a focal subject, framing/aspect ratio, one readable event or design feature, and compatible environment, light, medium, and palette. Keep part, material, color, and shape together. For contact or a shared prop, say who acts, what touches/supports what, and the current state. These are practical clarifications, not guarantees of geometry or a required formula.

## Base and individual slots

The base carries shared scene, style, framing, and subject counts (`1boy`, `2girls`, etc.) when appropriate. Human slots use `boy`, `girl`, or `other` without a number, followed by that person's identity, appearance, clothes, expression, and action. `1other` is not a generic object counter. Do not automatically append age, muscles, facial hair, or beauty tags.

Put independent traits/actions in their owner's slot; use a shared sentence for the relationship. Keep slot order, prose, and optional positions consistent. Per-character negative content can address leakage without excluding another subject's intended trait. `source#hug`, `target#hug`, and `mutual#hug` describe action roles but are not always reliable. Slots/positions can also describe animals or objects with careful wording; do not assign them human gender merely to use a slot. A simple object list needs no forced splitting. Coordinates guide placement, not depth, a camera, or a skeleton.

## Syntax and templates

Use `{detail}` (1.05x), `[detail]` (divide by 1.05), or a closed `1.2::detail::` span, not `(detail:1.2)`. V4.5/V5 support targeted negative emphasis such as `-1::hat::`; it is not a replacement for every UC exclusion. Check crop, ownership, and contradictions before increasing weights. Repeated tags do not establish a precise weight multiplier.

Quality and negative presets inject real words. Do not paste their expansions again. Inspect `nai_get_presets` when the intended style conflicts: Heavy can exclude dithering, halftone, multiple views, logo, and negative space; V5 Light includes sepia. Choose a compatible preset or `none` plus targeted UC, preserving user-supplied choices. V4.5 Curated quality includes `-0.8::feet::`; inspect it for an actual foot problem, not a blanket full-body ban. Complexity is a V5 density/style cue, not resolution, compute, or an automatic quality score.

## Lettering and models

Prefer the separate literal `text` field, or one final `Text:` block, never both. Describe a carrier, position, and reserved space before lettering. Blank lines separate text blocks; nothing follows the final block. Remove manually conflicting `no text`/text-suppressing UC. Frontend quote-to-text conversion is not a raw API guarantee. Inspect actual spelling and placement.

V5: up to 22 individual characters; flexible placement; English/Japanese prompting officially supported, other languages less consistent. Text limits are 750 characters Full / 374 Curated including whitespace. Full has broader training coverage; Curated cleaner/focused coverage, not a hidden extra-quality toggle. Native alpha is V5-only. Read [v5.md](v5.md) for special tags, prompt capacity, or alpha.

V4.5: up to six characters, 5x5 positioning, about 512 T5 tokens across base plus all slots, English lettering up to 118 characters. Reference workflows and capability differences require [v4.5.md](v4.5.md) or [advanced.md](advanced.md). Do not silently change models or infer V5 support from a shared API field. Dataset prefixes belong first only when deliberately requested.

## Planning and verification

For AI schedules use this core, the current recipe, chosen model, relevant library/design facts, and explicit locked fields/budgets. Fetch model, composition, text/artist, or editing detail only when required; do not load every guide or private history. Return only the requested planning output. Preserve authorization and limits; guide reading grants neither spending nor automatic execution.

Plugin defaults are 23 steps, Euler Ancestral, Karras, guidance 7 for V5 / 5 for V4.5; these are starting settings, not universal optima. Use current schemas/validation for compatibility. For comparisons hold model, seed, size, and settings fixed, change one meaningful factor, and inspect the actual image. Validation is not visual proof. Read [parameters.md](parameters.md) for cost, preset, or reproducibility details.
