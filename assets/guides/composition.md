# Composition, prompt diagnosis, and preserving intent

This guide applies to both families. V5 gives more room for detailed prose and multilingual scenes; V4.5 needs a tighter English description. Syntax and model limits remain in [v5.md](v5.md) and [v4.5.md](v4.5.md). The examples here are authored reasoning aids, not controlled image-generation results.

## Decide what the viewer must notice

Treat composition as an allocation of visible space. Identify the main subject, the event or design feature that makes it specific, and the supporting elements needed to read that feature. For example, a portrait needs enough pixels for expression; a handoff needs room for two bodies and their shared prop; an architectural interior needs sight lines through the space. Choose framing and aspect ratio to fit that task before adding decorative detail.

Translate mood into visible evidence. An abandoned observatory can show a broken lens, moss reaching into the entrance, and a single shaft of dawn light; `melancholic, beautiful, cinematic` alone does not establish those relationships. An illustrated item icon can use one readable silhouette, clear negative space, a limited palette and shading consistent with the requested game or anime style. Do not give the backdrop more competing focal points than the actual subject.

| Needed result | Useful visual decisions | Common conflict |
|---|---|---|
| Readable expression | Close or upper-body framing, unobscured eyes/mouth, readable facial light | Distant full-body shot plus tiny iris/eyelash details |
| Complete costume or creature silhouette | Full body, room above/below the subject, clear limb outline | Portrait/close-up anchors or foreground clutter over defining parts |
| Two subjects interacting | Side assignment, one shared event, contact points, enough lateral space | Each character independently holding the same prop or doing incompatible actions |
| Monumental environment | Distant masses, foreground scale cue, route or sight line | Every plane equally sharp, bright, and ornamented |
| Readable prop or item design | Part geometry, joins, support, one material per component | Detached lists of colors/materials with no ownership |
| Poster or icon | One strong silhouette, deliberately reserved lettering/empty region | Heavy UC suppressing `negative space`, or maximum complexity filling every gap |

`from above` describes the view, not an instruction to move the subject to the top of the canvas. Likewise, character coordinates place character regions; they do not encode a camera angle, a depth map, or a skeleton. Write actual foreground/background relationships in prose when they matter.

## Bind attributes to the right thing

Keep part, material, color, and shape together. Compare:

```text
teapot, brass, ivory, glass, blue, handle, lid, flowers, detailed
```

with:

```text
no humans, teapot, still life, simple background. The blue flower pattern is on the white teapot; the cup beside it has no pattern.
```

The second version assigns the blue flower pattern to the white teapot and distinguishes the unpatterned cup. This is a candidate clarification to inspect in the output, not a measured improvement.

For characters, keep shared setting, count, lighting, and event in the base prompt. Put appearance and clothing into each character's own prompt. A global `beard` UC would remove the older character's beard as well as preventing leakage onto another character; use the second character's UC instead. For animals and objects, use a short distinctive label in prose when more than one is present: "the white cat", "the larger brass key", "the open window". A simple object list need not be split into slots. When distinct positions or ownership matter, the official positioning system can also be used for objects or nonhuman subjects, with careful wording or prose reinforcement. Do not add human gender tags to those slots.

## Describe the current instant

Actions need a physically interpretable state. For a handoff, distinguish "about to pass", "both touching", and "already received". A concise shared-prop statement is more useful than a list of verbs:

```text
Two couriers face each other across a small counter. The courier in the blue jacket holds the parcel by its sides while the courier in the brown coat slides both palms underneath it. The parcel is still supported by both people.
```

The same reasoning helps a bird gripping a branch, a hinged mechanical lid, fabric pulled by a hand, or water spilling over a rim. Identify contact, support, direction, and the parts actually visible. If the pose keeps failing, simplify overlapping limbs or choose a view that exposes the contact. Repeated `perfect hands` cannot resolve contradictory geometry.

For a sequence, retain a compact continuity record: stable identity/design, held object, current object state, and scene lighting. Change only what the current shot changes. If a cup was in the right hand in one panel, a closer crop is not a reason to make it vanish in the next wider view. Multi-panel imagery is a visual task with uncertain layout adherence; do not promise exact panel counts, consistent lettering, or identity from prompt validation alone.

## Diagnose before adding more words

Inspect the result against the brief and name one visible failure. Then choose a correction that addresses its cause:

| Observed failure | Check first | Small useful correction |
|---|---|---|
| Missing feet or chopped-off antennae | Framing and margins; for feet with V4.5 Curated, also the quality suffix | Remove incompatible crop cues and explicitly fit the whole silhouette; inspect `-0.8::feet::` only for the foot issue |
| Wrong material/color on a component | Whether its ownership is explicit | Put material/color directly beside the part and its connection |
| Characters exchange hair or clothing | Shared traits mistakenly in the base; character alignment | Move traits to their owner, keep order/coordinates consistent, use local UC only if needed |
| Subject lost in clutter | Too many equal focal objects; busy style | Remove a competing prop or reduce background contrast/detail |
| A requested graphic style disappears | Automatic quality/UC conflicts | Inspect compiled text; choose a compatible template or `none` |
| Desired pose barely changes in img2img | Source pose, strength, conflicting pose text | Use a clearer intended pose and modestly increase strength; choose inpainting for a local change |
| Wrong words or stray lettering | Text carrier, free space, final text block, manual `no text` | Shorten text, reserve its region, remove conflicts, then inspect actual characters |
| Result has harsh edges or excessive saturation | Guidance and stacked style/quality emphasis | Lower guidance or remove one heavy emphasis while holding other settings fixed |

A missing detail is not always a weighting problem. The detail may be outside the crop, occluded, negated, too small to resolve, or attached to the wrong subject. Change the causal description first. Use one modest weight only when the description is coherent but underrepresented. Do not erase requested identity or replace a difficult scene with a generic attractive portrait just to obtain a cleaner image.

For a prompt-only edit, return the requested fragment or revised prompt. For generation, preserve seed/model/dimensions while testing a focused change. If the change works only on one seed, describe it as that result; test a second seed when robustness matters and the budget allows. Avoid changing the model, prompt, seed, and sampler together and then attributing success to one word.

## Quality and negative templates are creative choices

Keep the website-style defaults, `quality_preset: "standard"` and `negative_preset: "heavy"`, when they fit. They inject real words. They are not a neutral quality switch, and an empty custom `negative_prompt` does not turn the preset off. Use `nai_get_presets` for the exact chosen model and inspect the compiled prompt when a conflict is plausible.

| User's intention | Potential automatic conflict | Targeted response |
|---|---|---|
| Pixel-art dithering, print halftone, manga screentone | Heavy often suppresses those exact textures | Select a compatible Light preset after reading it, or `none` plus a small custom UC |
| Sepia ink or archival color | V5 Light UC includes `sepia`; Heavy includes scan/grain terms | Pick a template that preserves the intended material or write custom UC |
| Sparse poster / large empty margins | Many Heavy and Light lists include `negative space` or `blank page` | Use a compatible custom UC; do not counter it by endlessly increasing positive weights |
| Character sheet / turnaround | Heavy generally includes `multiple views`; some lists include `sequence`/`comic` | Disable that conflicting template and keep only useful artifact exclusions |
| Full-body V4.5 Curated design | Standard quality includes `-0.8::feet::` | If missing feet are an actual problem, compare a custom suffix without that term; do not automatically disable quality for every full-body request |
| Glowing mechanical eyes / unusual pupils | Human Focus can suppress `glowing eyes`, `mismatched pupils`, or other eye cues | Choose a nonconflicting UC instead of assuming Human Focus is best for every face |
| Flat furry mascot or furry comic | Furry Focus suppresses `simple`, `[flat colors]`, `outline`, `comic`, and more | Read the actual list; the name does not guarantee suitability for the requested style |
| Deliberate logo or typography | UC can contain `logo`; manual positive text may still contain `no text` | Remove the actual conflicts; the compiler only handles its own automatic `no text` |

Use `none` only for the conflicting side when appropriate: disabling UC need not disable quality, and vice versa. Avoid pasting the whole preset into the custom field while leaving the same preset enabled. If a user supplies a specific negative list, preserve it and explain any changes needed for an explicit visual goal.

Quality, aesthetics, and complexity are separate ideas. `masterpiece` and `very aesthetic` bias the learned look; V5 `high complexity` changes density/style. None directly raises pixel resolution or compute. The documented `year 2014` style cue is not a guarantee of historically accurate objects. Select a medium, edge treatment, palette, and lighting relationship appropriate to the brief; a longer stack of high-quality synonyms is not a substitute.

## Source grounding

Official sources: [Tagging](https://docs.novelai.net/en/image/tags), [Quality Tags](https://docs.novelai.net/en/image/qualitytags), [Undesired Content](https://docs.novelai.net/en/image/undesiredcontent), [Multiple Characters](https://docs.novelai.net/en/image/multiplecharacters), and [Artstyles](https://docs.novelai.net/en/image/tutorial-artstyles). The inspected official example set includes a [cat on a pillow](https://static.novelai.net/quickstart/v5/0074.webp), [cake still life](https://static.novelai.net/quickstart/v5/0096.webp), [graphic effects](https://static.novelai.net/quickstart/v5/0053.webp), and [blackboard lettering](https://static.novelai.net/quickstart/v5/0115.webp). Their metadata demonstrates actual examples, not measured success rates. Contact, continuity, and diagnosis methods are this project's practical synthesis; provenance and community cross-checks are in [sources.md](sources.md).
