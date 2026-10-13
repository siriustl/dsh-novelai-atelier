# Editing, enlargement, and visual references

> Evidence provenance: dated inspections, billing checks, and image experiments below are retained upstream historical evidence. Capability snapshots and observed costs are not permanent endpoint contracts. Current tool schemas, supported operations, and account checks govern each request; see [sources.md](sources.md).

Use this guide when there is an existing image or a requested reference. Read the source image before choosing a transformation. Record what must remain recognizable—identity, silhouette, pose, palette, lettering, or exact pixels—and what should change. The user's requested outcome determines the operation; these preservation goals are not equivalent.

The official behavior below was checked against all relevant image documentation and the current frontend on 2026-09-19/20. Practical starting values are suggestions, not measured optimal settings. Consult the connected tool's live schema for supported operations and model combinations.

## Choose the operation by the change

| Goal | Operation | What to expect |
|---|---|---|
| Reinterpret a sketch, alter the whole image, change style or pose | Image-to-image | Prompt-conditioned diffusion; any part can change |
| Improve detail while keeping the general image | Enhance | A second diffusion pass, optionally with a larger output; creative changes remain possible |
| Increase dimensions with minimal creative reinterpretation | Dedicated Upscale | No prompt or generation-setting control; inspect fine details and alpha afterward |
| Replace one hand, object, patch of background, or costume detail | Inpaint | Regenerate a mask-selected area using its surroundings as context |
| Expand the scene beyond an existing edge | Outpainting through Inpaint | Enlarge the canvas locally, mask the new space, describe the extended scene |
| Extract line art, recolor, adjust expression, remove background or clutter | Director Tools | Task-specific transformations; they can change more than the intended feature |
| Carry over broad visual cues from an image | Vibe Transfer | Style, color, and composition guidance; not an identity lock |
| Reuse a character's appearance or a specific style | Precise Reference on V4.5 | Stronger reference guidance, with strength/fidelity tradeoffs and per-reference cost |
| Retain exact pixels while changing file size, canvas, or format | Ordinary local image processing | No generative API call is needed for a deterministic file operation |

Do not silently switch from V5 to V4.5 for a model-specific reference feature. Explain the capability difference when it affects the requested result. Dedicated editing endpoints do not necessarily run the selected text-to-image model; do not label every derivative a newly sampled V5 image merely because its source came from V5.

The inspected current model capabilities distinguish these combinations:

| Capability | V5 Full | V5 Curated | V4.5 Full / Curated |
|---|---|---|---|
| Image-to-image / Enhance | Supported; img2img, regular and Max tested | Supported; img2img and Max tested | Supported; img2img tested on Full and Curated |
| Inpaint | Verified endpoint | Unavailable in the live endpoint test | Supported |
| Native alpha generation | Supported | Supported | Not supported |
| Vibe Transfer and encoded vibes | Not supported | Not supported | Supported; not with inpainting |
| Precise Reference | Not supported | Not supported | Supported, including official inpainting use |
| Vibe plus Precise Reference together | Not supported | Not supported | Incompatible |
| Legacy ControlNet | Not supported | Not supported | Not supported by these current model capabilities |

The 2026-09-20 authenticated test found that `nai-diffusion-5-curated-inpainting` returns a model-does-not-exist error, despite its presence in the frontend capability enum. V5 Full inpainting succeeded. This wrapper rejects V5 Curated inpaint locally: select V5 Full or V4.5 explicitly when appropriate. Do not silently substitute a model or claim that a frontend enum proves the endpoint is deployed.

This is a model capability table, not a claim that every combination has a separate wrapper tool. This version exposes references through `nai_generate_image` for text-to-image; Precise Reference combined with inpainting is an official capability that this wrapper does not yet expose. Do not add undeclared reference fields to `nai_edit_image` with `operation:"inpaint"`.

## Prepare local inputs and masks

`nai_prepare_image` makes a new local PNG without contacting NovelAI. Supply `image_path`; provide both `width` and `height` in multiples of 64 to resize, or omit both to keep a compatible source/crop size. `contain` fits and pads, `cover` fills and crops centrally, `stretch` deliberately distorts the aspect ratio, and `pad` centers the original pixels on a larger canvas without scaling. Optional `crop_box` uses EXIF-oriented source pixels before resizing. A background such as `#ffffff` or `transparent` controls padding.

For an inpainting mask, `mask_boxes` and `mask_polygons` use the **final canvas** pixel coordinates. Rectangles are `[left, top, right, bottom]` with right/bottom excluded; polygons need at least three points. Regions are combined as white repaint areas on black. This is geometric mask construction, not automatic object segmentation. Inspect whether the chosen regions contain the complete structure to change.

```json
{
  "image_path": "/absolute/path/to/source.png",
  "width": 512,
  "height": 768,
  "mode": "contain",
  "mask_boxes": [[0, 256, 512, 768]]
}
```

Pass this as `{"request": <object>}` to `nai_prepare_image`. Use its returned `image_path` and `mask_path` in an inpaint request. For outpainting, use `pad` and mask the added canvas bands while preserving the source rectangle. The inpaint tool still aligns the mask to an 8-pixel grid; local preparation itself costs no Anlas.

## Image-to-image: describe the intended result

The image supplies spatial and color evidence; the prompt describes the desired output. Start from a concise description of what should remain, then replace the changed detail. A request to recolor a coat needs the retained person, framing, coat shape, and new material/color—not unrelated scenery or a new face design. Retaining the original full prompt without removing the old coat color creates competing instructions.

Example, specifying a different jacket color in an anime illustration:

```text
1boy, solo, black hair, blue eyes, red jacket, white shirt, upper body, outdoors, night. The jacket is red; the shirt underneath remains white.
```

This describes the output rather than issuing an instruction such as "edit image #1" inside the prompt. Image paths belong in the tool request. "Same" is a useful reminder in prose, not a guarantee of geometric identity. For an exact color replacement or exact pixel geometry, deterministic editing may be the better fit; an img2img request is a generative redraw.

- **Strength** controls freedom to depart from the initial image. Low values preserve more of its structure; high values can change pose, face, silhouette, and composition. More strength can make an intended change possible when the source is resisting it.
- **Noise** creates room for new details. It can help fill a plain area with requested structure, but it is not a generic sharpness slider. Repeated high-noise passes can accumulate artifacts.
- **Guidance** controls prompt influence during generation. Raising it is a separate experiment from raising strength; excessive guidance can harden edges or saturate colors.

For restrained refinement, a low-strength pass around 0.15–0.30 with little or no added noise is a practical first experiment. For a broad reinterpretation, around 0.55–0.80 gives substantially more freedom. These are this guide's starting ranges, not official quality guarantees; choose based on the source and desired change, and honor the actual schema range. Hold source, seed, size, and noise fixed while tuning strength so the comparison means something.

`nai_edit_image` with `operation:"img2img"` accepts flat fields or an outer `request` with `image_path` and the normal prompt/model settings. Its default strength is 0.7, which can make large changes; explicitly choose a lower strength for gentle edits. `width` and `height` default to source dimensions. If changing them, supply both; this tool resizes a working copy rather than overwriting the source. Match the source aspect ratio unless a deliberate stretch is intended. Local crop/pad preparation gives more control than an accidental resize.

Do not repeatedly feed every derivative into the next pass. Return to the original when comparing settings, then keep the best accepted revision as a new baseline. If the aim is an unchanged copy, copy the file locally; minimal diffusion settings are not a byte-for-byte preservation promise.

In one local blue-to-green coat comparison on each V5 model, strength 0.35 retained blue despite a green target prompt and `blue coat` UC; 0.65 changed the coat to green but also changed costume details and proportions. These values are observations for that source, not universal thresholds. A stronger pass may achieve the edit by redesigning the subject; inspect both change and preservation.

## Inpaint: give the model the whole repair

`nai_edit_image` with `operation:"inpaint"` uses `image_path` and `mask_path`. In this plugin, **white marks the region to regenerate; black marks the region to preserve**. Source, mask, and target dimensions must agree; the tool does not silently resize an inpaint request. Inspect the prepared mask visually before spending on an edit, especially if it was exported from an editor with a different mask convention.

The default `mask_mode: "luminance"` reads black/white brightness. Use `mask_mode: "alpha"` only for a mask with an alpha channel: opaque means repaint, transparent means preserve. The API working mask is binary and aligned to an 8-pixel grid. Final composition additionally uses the original user mask thresholded at >127, so alignment cannot alter pixels outside the original selected region. Very thin strokes can disappear and gray gradients do not remain soft feathering; prepare a clear region with enough width for the desired repair.

### Focus a small region at higher resolution

Optional `focus_box: [left, top, right, bottom]` selects a source-pixel rectangle containing every selected mask pixel plus enough surrounding context. Right/bottom are excluded. `focus_size: [width, height]` sets the submitted working tile in multiples of 64; match the crop's aspect ratio. The tool crops/resizes image and mask, transforms explicit character positions into crop space, inpaints, then resizes the generated patch back into the original canvas. Character positions outside the focus region are rejected; adapt the local description or omit positions rather than silently assigning those characters to the crop.

Final output dimensions remain those of the source. Omit ordinary `width`/`height`; the original canvas may have non-grid dimensions because only the tile is submitted. The original black-mask pixels are preserved exactly in all RGBA channels. Cost/eligibility follows the submitted tile and steps, not the final composited canvas. Use `nai_quote` on the actual request before paid work. This is a wrapper implementation of crop-based editing, not a promise of improved anatomy or texture.

```json
{
  "image_path": "/absolute/path/to/source.png",
  "mask_path": "/absolute/path/to/mask.png",
  "prompt": "1boy, black hair, purple eyes, blue coat, anime coloring",
  "focus_box": [320, 32, 544, 256],
  "focus_size": [512, 512],
  "seed": 730061
}
```

Coordinates in this example belong to its particular source; inspect your own image and mask before adapting them. Local eye/glove comparisons changed the requested colors with both whole-canvas and focused processing. Focused results had different detail and shape, without consistently preserving expression or hand geometry better. All ten edit/outpaint test images preserved the original unselected RGBA pixels; successful pixel preservation does not establish perfect seam or anatomy quality.

A mask should include the complete defective structure and enough room to join it to its surroundings. For a bad hand around a mug, masking only one finger can preserve the wrong wrist or grip. Include the hand and relevant contact edge while leaving the face and other protected areas outside. Avoid a mask boundary running directly through a seam that needs to be reconstructed. Expanding a mask means consenting to regenerate that added area, so keep it proportional to the requested repair.

The prompt should describe the desired local result in its scene context. For example:

```text
close view of a gloved hand holding a ceramic mug. Four fingers curl around the mug handle, and the thumb rests along the top of the handle. The navy sleeve ends at the glove cuff. Warm light from the left matches the surrounding image.
```

Retain short subject/style cues when they help the patch match the image. Do not add a long unrelated full-scene inventory to a small repair, or expect `bad hands` alone to specify the grip. For a local letter or symbol, inspect the exact characters afterward; a generative repair is less reliable than typesetting when precise text is required.

Inpainting strength can preserve a useful rough shape at lower values or reconstruct the patch at higher values. The official example compares 0.55, which follows a drawn sword guide closely, with 1, which is driven much more by the prompt. This plugin defaults to 1; lower it explicitly when the masked shape is already useful. Correct multiple unrelated failures one at a time when that improves control and fits the budget.

Afterward, check the patch edge, color/lighting continuity, and the protected regions. This plugin composites generated pixels only inside the original thresholded user mask; it also saves the raw API image separately in `raw_api_image_path`. That preservation comes from local composition, not a guarantee about untouched pixels in the raw API response. The API's 8-pixel mask can differ slightly from the final boundary. Inspect the final composite rather than substituting the raw image when preservation matters.

The `focus_box` workflow implements crop, enlargement and placement back into the original. It does not select a semantic region for you: keep unmasked surrounding context so the model can see how the repair should connect. Its working mask is aligned after enlargement, allowing small selected details to occupy more API pixels.

**Outpainting** uses a locally expanded canvas whose old image is preserved and whose new area is masked. Describe what continues into the new area, including horizon, perspective, palette, and light. A narrow masked overlap can help a join, but it also makes those original edge pixels editable. Choose a supported final canvas and show the expanded mask before generation when its boundary is important.

## Upscale versus Enhance

`nai_edit_image` with `operation:"upscale"` takes an `image_path` and enlarges each edge by 2, producing 4 times the pixel area. A 512×512 source becomes 1024×1024. There is no free-form scale factor or creative prompt for this endpoint. A prompt such as "repair the fingers" cannot steer it. Inspect the output dimensions, fine lines, text, small facial details, and alpha rather than repeating the documentation's idealized "no artifacts" wording as a guarantee.

`nai_edit_image` with `operation:"enhance"` is a convenience for an image-to-image diffusion pass. It still uses the requested prompt, model, strength, and noise; it is not a separate prompt-free upscaler. Its default strength is 0.2 and noise is 0. In `mode: "regular"`, supply both `width` and `height` when enlargement is also intended; otherwise source dimensions are used. Regular Enhance adds the official `-2::upscaled, blurry::` prompt fragment by default; set `append_enhance_tags: false` when that bias conflicts with intentionally soft/blurry art. It is separate from the chosen quality/UC templates.

V5 also exposes `mode: "max"`: the server chooses a larger final size, up to approximately 3 megapixels. Do not supply a different target width/height or promise an exact final size for this mode. Max Enhance does not append the regular Enhance fragment. Both modes remain creative diffusion; higher strength can replace identity or lettering even if the result looks sharper.

Use dedicated Upscale for a finished image that mainly needs more pixels. Use Enhance for an image whose content/detail may usefully be reinterpreted. For a finished image with one defective area, repair that region before enlargement rather than redrawing everything. Keep originals and record the sequence; the last PNG's generation dimensions can differ from its actual pixel dimensions after postprocessing.

## Director Tools

Director modes are distinct jobs rather than additional text-to-image quality settings:

- **Remove Background:** official output variants are Masked, Generated, and Blend. Masked preserves the source through a generated mask but can retain foreground clutter; Generated may invent missing hair or covered detail; Blend can show seams where they differ. Inspect all returned candidates rather than assuming their archive order or a "best" variant.
- **Line Art / Sketch:** interpret edges and drawing structure. They need visual inspection for missing or invented lines; they are not vector tracing or layer recovery.
- **Colorize:** use a small prompt that binds the desired colors to actual parts. Defry controls noise/over-strong color in this operation; it is not img2img strength and should not be copied across tools. Existing colored images can also be recolored.
- **Emotion:** strongest documented use case is a clear, single, frontal anime face. A requested expression can alter clothing or other areas too. Keep identity cues concise, inspect likeness, and consider a neutral-expression intermediate only when the source expression is resisting the requested change.
- **Declutter:** can remove stray writing, speech bubbles, or floating objects. It is not appropriate when the exact lettering or adjacent design elements must be kept unchanged.

`nai_edit_image` with `operation:"augment"` takes `image_path` and a `tool` value: `bg-removal`, `lineart`, `sketch`, `colorize`, `emotion`, `declutter`, or `declutter-keep-bubbles`. Only `colorize` and `emotion` accept the extra `prompt` and `defry` fields; Director prompts do not receive the text-to-image quality/UC template compiler. For `emotion`, provide the enum `emotion` separately and ordinary visual detail in `prompt`; do not type the raw `;;` protocol separator. `defry` is an integer 0–5; for emotion, 0 means the strongest change and 5 the weakest. Consult the actual enum for available emotion names. Use `declutter-keep-bubbles` when speech bubbles should be retained, then inspect that they survived.

For colorization, "ivory ceramic body, brass handle, cobalt-blue lid" is a useful prompt; "best quality, amazing masterpiece" does not assign colors. For expression changes, describe the eyes, brows, and mouth if a generic emotion name is insufficient. Avoid adding unrelated costume or background changes to the same pass.

## Visual references: choose what must transfer

**Vibe Transfer** carries visual cues. Reference strength governs their influence; excessive influence can pull the result away from the new prompt. The official recommendation is generally to keep the sum of strengths at or below 1.0. Normalizing strengths is a deliberate client operation, not an assumption about the raw API.

For the four models this plugin covers, Vibe Transfer is a V4.5 workflow. Generic documentation saying "V4 or higher" does not establish V5 support; the current V5 capability matrix disables both ordinary and encoded vibes. V4.5 inpainting also does not accept Vibe Transfer.

Information Extracted is different from reference strength. The V4+ documentation says reducing it first loses high-frequency detail such as texture, retaining relatively more composition and less style. Do not teach that lowering it always removes the background or always preserves style. If an unwanted layout transfers, reduce reference strength, crop/choose a better reference, or switch reference method based on what needs to survive.

Encoding a V4+ vibe normally costs 2 Anlas; changing Information Extracted requires a new encoding. Reuse saved compatible encodings when possible. Above four vibes, the docs list an extra 2 Anlas per additional vibe per image. `nai_edit_image` with `operation:"encode_vibe"` accepts `image_path`, a V4.5 `model`, and `information_extracted` (default 0.7), then saves a raw `.vibe` with a receipt. This is not the website's `.naiv4vibe` JSON export. Keep the receipt so the saved model and Information Extracted setting can be checked. Encodings in PNG metadata do not restore the original reference pixels.

In `nai_generate_image`, put reusable vibes in `vibes`, each with `encoding_path` and `strength` (default 0.6). `normalize_vibe_strengths` defaults to true. An existing `.naiv4vibe` export is also accepted; an optional `information_extracted` selects an already encoded variant. It does not create a new encoding or spend an encoding fee behind the scenes. Do not send an ordinary PNG as `encoding_path`, or treat a saved encoding as automatically compatible with a different model.

**Precise Reference** is documented for V4.5, with Character, Style, and Character & Style modes. It adds 5 Anlas per reference per generation and is incompatible with Vibe Transfer. Several character references currently blend their appearances; they do not automatically bind to separate character-prompt slots. For two distinct people, do not promise one-to-one identity assignment from two references.

Use `precise_references` in `nai_generate_image`, each with `image_path`, `type` (`character`, `style`, or `character&style`), `strength`, and `fidelity`. Do not also supply `vibes`. Live API testing confirmed that an eligible Opus base sample retains its discount with Precise Reference: one reference at 512×512 and 23 steps cost 5 Anlas. Add 5 Anlas per reference plus any non-discounted base generation cost. Use the live quote for the actual account and settings; the 5-Anlas observation does not make every reference request cost only 5.

Reference strength controls influence; fidelity controls how strictly the reference is applied. High values can hold onto the source expression/angle/pose when the request needs a new one. Reduce the relevant setting if the reference is overconstraining the scene, rather than writing an ever-longer contradictory prompt. If a particular garment is being missed, reinforce its visible design in text.

A clean reference with a simple background and readable silhouette is a useful starting point. A full-body neutral pose serves varied views; an upper-body reference can make facial/costume details larger for an upper-body output. The official reference canvas sizes are 1024×1536, 1472×1472, and 1536×1024; fitting/padding is part of reference preprocessing, not a request to force the generated image to that paid resolution. Turnarounds may help varied views, but quality/UC presets that suppress `multiple views` conflict when creating the reference sheet itself.

**Reference inpainting** is a different technique: preserve small reference insets in the canvas, mask the rest, and describe the desired image with `reference inset`. Those unmasked insets remain visible until locally cropped out. Do not confuse it with the Precise Reference API or promise that it produces a clean final canvas without preparation and cleanup.

## Budget and verification

`nai_quote` is optional when the user needs cost information; it does not generate or authorize anything. Generate/edit directly when the requested scope is clear. Remote work can incur Anlas; follow the user's paid-work intent and report unknown cost honestly. Multiple requested images use sequential calls rather than a model-facing batch queue.

Generation/editing calls accept flat fields or fields wrapped in `request`; nested fields win when duplicated. Quote and offline `nai_quote` with `offline:true` use the same request body plus a top-level `operation` selector:

| Tool | Quote/validation `operation` |
|---|---|
| `nai_generate_image` | `generate` |
| `nai_edit_image` with `operation:"img2img"` | `img2img` |
| `nai_edit_image` with `operation:"inpaint"` | `inpaint` |
| `nai_edit_image` with `operation:"upscale"` | `upscale` |
| `nai_edit_image` with `operation:"enhance"` | `enhance` |
| `nai_edit_image` with `operation:"augment"` | `augment` |
| `nai_edit_image` with `operation:"encode_vibe"` | `encode_vibe` |
| `nai_generate_image` | `reference_generate` |

For example, `nai_quote({"operation":"upscale","request":{"image_path":"/absolute/path/to/image.png"}})` gives optional cost information; `nai_edit_image({"operation":"upscale","image_path":"/absolute/path/to/image.png"})` performs the requested enlargement. Use an actual existing path; the string here is illustrative.

Use a small image for an unfamiliar paid workflow when it can still reveal the needed behavior. A 512×512 test is useful for endpoint behavior, broad color, or simple masks, but insufficient evidence of readable dense lettering, subtle face likeness, or final-size detail. Reference surcharges remain even at a small output size. This wrapper submits the source dimensions directly: 512×512 background removal was verified at 20 Anlas. The website enlarges small Director inputs to about 1MP first, which explains its approximately 65-Anlas estimate. Inspect the current quote for the request being submitted. Use current quotes and balances rather than classifying every edit as always paid or always free.

Quotes are optional estimates, not charge guarantees or reservations. Generation does not automatically poll balances or pause for billing reconciliation. Unknown transport outcomes are not automatically resubmitted; inspect an existing receipt using `nai_image_info` with `action:"operation"`, without manually retrying the POST. Use `nai_check_credits` only when account information is needed. See [parameters.md](parameters.md).

Deliver original/output paths, operation, model when applicable, important settings, source/mask/reference identities, and the visible result. Distinguish "tool returned a valid image" from "the requested repair or likeness succeeded".

## Official references

[Image2Image](https://docs.novelai.net/en/image/controltools), [Strength & Noise](https://docs.novelai.net/en/image/strengthnoise), [Inpaint](https://docs.novelai.net/en/image/inpaint), [Enhance](https://docs.novelai.net/en/image/enhance), [Upscale](https://docs.novelai.net/en/image/upscale), [Director Tools](https://docs.novelai.net/en/image/directortools), [Vibe Transfer](https://docs.novelai.net/en/image/vibetransfer), and [Precise Reference](https://docs.novelai.net/en/image/precisereference). See [sources.md](sources.md) for complete coverage and documentation/frontend discrepancies.

### Direct API cost observations

The 2026-09-20 tests submitted original 512×512 images. Dedicated 2× upscale cost 1 Anlas, one V4.5 Vibe encoding cost 2, and an eligible Opus single-reference generation cost 5. Direct background removal cost 20 and returned three outputs. The website first enlarges a small Director input to about 1MP, which explains its approximate 65-Anlas background-removal estimate; this tool retains the submitted size. Keep image-processing choices separate from billing assumptions. These observations validate the current quote logic, not an immutable server price contract.

### Observed edit limitations

In a small same-subject test, img2img strength 0.4 kept much of the source navy coat even though the prompt requested emerald green. A rectangular inpaint region covering only part of the coat also retained the surrounding color. This is evidence of a specific under-specified edit, not a universal strength threshold: cover the full semantic region that should change, preserve the regions that must not change, and consider a targeted positive/negative color contrast or a stronger denoising setting before adding generic quality words. The reference-generation sample did produce a green coat, while also allowing a broader pose/composition change. Choose the workflow for the intended degree of change.
