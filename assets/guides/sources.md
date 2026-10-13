# Sources, coverage, and confidence

> Evidence provenance: the dated reads, deployment snapshots, billing checks, and image counts retained below are upstream historical records. Public sources were rechecked on **2026-10-02** for this guide review. Historical image experiments were not rerun, and source-project archives are not shipped runtime files. Current schemas, quotes, and account state govern live requests.

## 2026-10-02 public-source review

The original Codex plugin's skill, model guides, documentation findings, and source index were read first, without reading its implementation, credentials, or private generation records. The following current pages were actually opened and their relevant article text read, not accepted from search summaries:

| Source | Official fact retained |
|---|---|
| [Models](https://docs.novelai.net/en/image/models) | Full has broader coverage, Curated cleaner/focused coverage; V5 base budgets about 1471/703 effective tokens; V4.5 about 512 T5 tokens across base and all slots |
| [Multiple Characters](https://docs.novelai.net/en/image/multiplecharacters) | V5 up to 22; V4/4.5 six and 5x5 positions; counts in base, unnumbered categories in human slots; objects can be positioned; action-role prefixes are not always reliable |
| [Emphasis](https://docs.novelai.net/en/image/strengthening-weakening) | Braces 1.05x; numerical spans V4+, negative values V4.5+; targeted removal and UC serve related but different purposes |
| [Text Rendering](https://docs.novelai.net/en/image/textrendering) | Final `Text:`; blank-line blocks; 750/374/118 **characters**; base text usually most reliable, not a prohibition on character-box lettering |
| [Quality Tags](https://docs.novelai.net/en/image/qualitytags) | V5 Light/Standard expansions remain as listed in [v5.md](v5.md); V4.5 page still differs from retained frontend presets |
| [Undesired Content](https://docs.novelai.net/en/image/undesiredcontent) | Exact model-specific lists, including style/layout conflicts; preset labels are not identical across models |
| [Tags](https://docs.novelai.net/en/image/tags) | V5 complexity/depth/era/alpha controls; dataset prefixes first; stronger earlier-tag rule explicitly concerns V3 and lower |
| [Steps and Guidance](https://docs.novelai.net/en/image/stepsguidance) | More steps/guidance need not improve results; generic V3+ guidance recommendation 5-6 is not a V5 optimal-value experiment |
| [FAQ](https://docs.novelai.net/en/faq#opus-usage-limits) | 23 steps is default; rechargeable V5 allowance estimates depend on steps/pixels; renewal is not instant refill |
| [Prompt Mixing](https://docs.novelai.net/en/image/promptmixing) | Legacy `|` vector mixing is V3 and lower, not a V5 artist blending recipe |
| [V5 page](https://novelai.net/v5) | English/Japanese officially supported prompt languages; other named languages usable but less consistent; quoted-text conversion belongs to the frontend |
| [V5 release journal](https://journal.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d) | Release explains Max Enhance, native V5 Full inpaint, and website fallback from Curated to V4.5 Curated; fallback is not native V5 Curated support |

The public [Image API Swagger JSON](https://image.novelai.net/docs/doc.json) was reachable and its endpoint section read; the browser extraction was truncated at 50,000 characters, so this pass does **not** claim a complete schema re-audit. It exposes image generation, tag suggestions, editing, and separate API hosts. A shared field/schema does not prove every model supports it. It also requires human-initiated requests and disallows automation creating excessive load: a schedule's user authorization and local budgets do not independently establish compliance with service terms.

### Community cross-check and limits

The [Miint-Sunny repository](https://github.com/Miint-Sunny/nai5-prompting) now advertises **v1.2c-nightly, 2026-09-25**. Its README and [writing conventions at commit 353ac9e](https://github.com/Miint-Sunny/nai5-prompting/blob/353ac9e714b9b75f545880c9c12b68c92abab89e/skills/nai5-writing/references/conventions.md) were read. Useful experience remains local-edit fidelity, explicit ownership/contact, preset conflict checks, and on-demand reading. Its default negative-weight block, fixed field division, four-panel 2x2 reading order, and V5/V4.5 weight comparison are personal conventions or unverified generalizations, **not official mechanics**. Do not append negatives after final lettering, forbid individual-slot actions, rewrite locked UC, or import its private-library assumptions. The GPL-3.0-only source was consulted, not copied into these guides.

The [ComfyUI client README](https://github.com/raspie10032/ComfyUI_RS_NAI_API_Request/blob/31d345752e36c9596fd5142cd6e5d7fdc262742d/README.md) describes V5 `params_version: 4`, continued `v4_prompt` / `v4_negative_prompt` structures, V4.5-only Variety+, normalized coordinates, and Curated inpaint fallback. These are **community compatibility observations**, not a public per-model API contract. Its five exposed slots and 0.1 coordinate increments are that client's limits, not V5's capacity/precision. Other retained API sources include [caru-ini/novelai-sdk](https://github.com/caru-ini/novelai-sdk) and [LlmKira/novelai-python](https://github.com/LlmKira/novelai-python); their local documentation informed the original source index, not a fresh endpoint test here.

### Changes and uncertainty

The shared [prompting core](prompting.md) is the minimal AI-planning context; [overview.md](overview.md) is a topic directory. Gender-specific navigation was removed, while applicable count/identity/design rules, mixed subjects, official `attractive male`, and authored examples remain. Full model guides preserve their established mechanics rather than imposing a new universal formula.

Still uncertain or dated: text **tokens versus characters** disagreement; V4.5 quality-page versus frontend expansions; launch promises versus later deployment of V5 references/inpaint; hashed frontend bundle URLs; exact character-slot prompt budget; cross-model weight equivalence; exact layout/contact and artist identity fidelity. Validate against current tools and inspect images where appropriate. This review provides no aesthetic success rate, new visual result, billing guarantee, or new spending authorization.

## Historical source coverage


Reviewed 2026-09-19. The complete official English `/image` routing manifest embedded in `https://docs.novelai.net/en/image` contained **28 pages**, including the three image tutorials. Every one was fetched and its complete article text read before UI-only operations were filtered from the teaching guides. Links found across the downloaded image pages introduced no additional English image routes. The sitemap URL returned 404; discovery therefore used the site's own English route manifest and link cross-check, not a guessed list of topics.

The repository's upstream documentation-coverage records contain per-page status, snapshots, hashes, reading notes, and dispositions. They are research provenance rather than required runtime dependencies of this portable skill. Primary links below remain usable when the skill is copied to another harness.

The 2026-09-20 extension reread the relevant editing, quality/UC, and reference pages to build [composition.md](composition.md) and [advanced.md](advanced.md). These guides add workflow decisions and authored examples while retaining the distinction between documented behavior, current API fields, and practical advice. New behavioral checks and interface reconciliation are recorded in the repository's unbundled upstream guide-review archive; they do not claim image-quality evidence from offline validation.

The extension's protocol evidence is recorded in unbundled upstream protocol report. The deployed [app bundle](https://novelai.net/_next/static/chunks/pages/_app-82fe03e3291d150d.js), module 11366, supplies the capability matrix; [request preparation](https://novelai.net/_next/static/chunks/2952-0b37f4043b37a3af.js) supplies image/mask/reference behavior; [pricing helpers](https://novelai.net/_next/static/chunks/1601-570fd9e21fc1a9a0.js) supply cost estimates. These are dated deployment snapshots, not permanent API contracts.

## Official image documentation, complete coverage

| Page | Retained learning after full reading |
|---|---|
| [Overview](https://docs.novelai.net/en/image) | Resolution, batch cost, text-to-image versus base-image settings |
| [Basics](https://docs.novelai.net/en/image/basics) | Tags + prose, medium/framing, context economy, guidance/seed principles |
| [Models](https://docs.novelai.net/en/image/models) | V5 and V4.5 model behavior, context limits, languages, free-generation differences |
| [Tagging](https://docs.novelai.net/en/image/tags) | V5-specific male/complexity/alpha tags; dataset prefixes; quality/aesthetic/year tags |
| [Strengthening & Weakening](https://docs.novelai.net/en/image/strengthening-weakening) | 1.05× braces, numerical emphasis, negative emphasis, closing spans |
| [Steps & Guidance](https://docs.novelai.net/en/image/stepsguidance) | Guidance tradeoffs, iteration counts, rescale/decrisper context |
| [Seed](https://docs.novelai.net/en/image/seed) | Controlled comparisons and limits on exact reproducibility |
| [Quality Tags](https://docs.novelai.net/en/image/qualitytags) | Documented suffixes and preset conflicts; compare current frontend/runtime where the page is stale |
| [Undesired Content](https://docs.novelai.net/en/image/undesiredcontent) | Exact model-specific negative presets and targeted exclusion |
| [Multi-Character Prompting](https://docs.novelai.net/en/image/multiplecharacters) | Count versus per-character prompts, 22/6 characters, positioning, action roles |
| [Prompt Randomizer](https://docs.novelai.net/en/image/promptrandomizer) | Template expansion and actual prompt; seed does not freeze random choices |
| [Prompt Chunks](https://docs.novelai.net/en/image/promptchunks) | Macro expansion, nested-chunk syntax risks; UI management omitted |
| [Text Rendering](https://docs.novelai.net/en/image/textrendering) | Final `Text:` placement, languages, character limits, no-text conflicts |
| [Image2Image](https://docs.novelai.net/en/image/controltools) | Prompt/source relation, preservation versus reinterpretation, source aspect ratio |
| [Strength & Noise](https://docs.novelai.net/en/image/strengthnoise) | Base-image transformation parameters, not text-to-image knobs |
| [Vibe Transfer](https://docs.novelai.net/en/image/vibetransfer) | Information/strength semantics, encoding costs, metadata; no unsupported tool claims |
| [Precise Reference](https://docs.novelai.net/en/image/precisereference) | V4.5 scope, costs, reference design and incompatibilities |
| [Director Tools](https://docs.novelai.net/en/image/directortools) | Task-specific editing, background variants, expression limitations; clicking instructions omitted |
| [Canvas](https://docs.novelai.net/en/image/editimagecanvas) | Base-image aspect matching and editable guides; UI tools/hotkeys omitted |
| [Inpaint](https://docs.novelai.net/en/image/inpaint) | Mask/context design, strength, focused/reference inpainting, outpainting preparation |
| [Enhance](https://docs.novelai.net/en/image/enhance) | Creative second diffusion pass versus upscaling |
| [Upscale](https://docs.novelai.net/en/image/upscale) | Separate non-prompt-conditioned enlargement feature |
| [History](https://docs.novelai.net/en/image/history) | Session-only retention motivates local file/metadata persistence; UI actions omitted |
| [Prompt Mixing](https://docs.novelai.net/en/image/promptmixing) | Legacy feature limited to V3 and lower; do not use on V5/V4.5 |
| [Sampling](https://docs.novelai.net/en/image/sampling) | Sampler effects and legacy context; no unsupported SMEA generalization |
| [Intro Tutorial](https://docs.novelai.net/en/image/tutorial-imgintro) | Basic tags, saved metadata, controlled edits; legacy claims qualified |
| [Character Tutorial](https://docs.novelai.net/en/image/tutorial-charactercreation) | Stable identity anchors, male facial hair/body tags, framing conflicts |
| [Artstyles Tutorial](https://docs.novelai.net/en/image/tutorial-artstyles) | Medium/palette/effects and quality/negative-preset conflicts |

Supplemental official pages were also read in full:

- [Subscription](https://docs.novelai.net/en/subscription): current tiers and general free-generation envelope.
- [FAQ](https://docs.novelai.net/en/faq): V5 Opus rechargeable usage mechanics, 23-step default, model case sensitivity, metadata, and cost clarifications.

## Source priorities and actual conflicts

**Current image OpenAPI, found 2026-09-20:** [Image API Swagger JSON](https://image.novelai.net/docs/doc.json) and [its UI](https://image.novelai.net/docs/index.html) expose image request parameters, V4-style caption structures, preset/alpha hints, editing/reference fields and V5 usage semantics. The earlier `/docs` 404 and old API-host Swagger do not establish that no current image documentation exists. This shared schema still does not establish that each field works on all four models; current client capabilities and actual endpoint tests remain necessary. It confirms that `timeUntilNextPercent` means seconds to add one percentage point from the current percentage, including a fractional starting value.

**Text length:** The model overview calls V5 text budgets tokens, while the dedicated Text Rendering page says **characters**, including whitespace/newlines: 750 Full, 374 Curated, 118 V4.5. The skill conservatively follows the specialized text page and explicitly preserves the discrepancy instead of inventing a tokenizer equivalence.

**Tag order:** The Basics and old Intro pages give broad front-of-prompt priority advice. The more specific Tagging page associates strong positional weighting with V3 and lower. The guides retain a readable subject-first structure without claiming every early V5/V4.5 tag has a fixed larger numeric weight.

**Natural language and Unicode:** The old Intro says the AI was trained on English tags rather than natural language. Current model pages explicitly describe natural language support in V4/V4.5 and improved multilingual support in V5. Current model-specific descriptions take precedence.

**Per-character counts:** An example on the text-rendering page uses `1girl` inside a character segment. The current dedicated multi-character guide explicitly says counts belong in the base and character prompts use `boy`, `girl`, or `other` without numbers. The skill follows the explicit rule.

**Free resolution:** The Subscription body contains the phrase "at least Normal Sized," but its page-top footnote, Basics, and Steps pages describe the normal maximum. The guide uses a supported normal pixel budget, one image and at most 28 steps; optional account information can clarify current eligibility. It does not treat that apparent typo as permission to generate larger images for free.

**Legacy samplers:** The Sampling page discusses SD-era SMEA/SMEA DYN globally. Its existence is not a current V5 capability matrix. Live API/front-end validation must determine supported model/sampler/settings combinations.

**Unlimited Opus:** Old tutorials say Opus permits unlimited free image generation under normal constraints. Current Models and FAQ explicitly limit V5's free allowance while keeping older models unaffected. The skill follows current model-specific billing statements.

**V5 low percentage versus exhaustion:** The inspected frontend uses `usage.isNegative` for exhausted-allowance pricing; `percent < 5` is a low-allowance warning. The previous plugin's 5% cutoff was a local restriction, not an official requirement, and has been removed. A live nonnegative usage state can remain free at displayed 0%. Generation follows the user's intent and can incur Anlas; optional quotes are information, not an enforced spending cap or a required preflight.

**Upscale wording:** The docs say resolution increases "four times"; the inspected endpoint enlarges each edge by 2, giving 4 times the area. It is prompt-independent. Enhance is a creative second diffusion pass and may also change dimensions; these are different operations.

**Focused inpainting:** The documented website feature crops and enlarges a region with surrounding context before putting it back. Since v0.4.0 this wrapper explicitly implements crop/rescale/composite using `focus_box`/`focus_size`, including character-coordinate transformation, submitted-tile pricing and original-mask pixel preservation. These are local wrapper operations, not an undocumented server switch.

**Reference support:** The generic Vibe page's "V4 or higher" language is broader than the deployed capability matrix: V5 disables Vibe/encoded vibes and Precise Reference. V4.5 enables both reference systems, but they are mutually incompatible; Vibe is also disabled for inpainting. Current capabilities take precedence over extrapolating a feature to all later model names.

**V5 Curated inpaint deployment:** The capability enum contains its inpainting variant, but the 2026-09-20 live request returned `Validation error: model nai-diffusion-5-curated-inpainting doesn't exist` twice with no Anlas deduction. V5 Full inpaint succeeded. The wrapper therefore rejects V5 Curated inpainting instead of silently routing it elsewhere. Live endpoint evidence takes precedence over the advertised capability; a later deployment can warrant rechecking it.

## What is official versus practical synthesis

Direct official facts include documented tag spellings, quality/UC expansions, emphasis semantics, count conventions, model-language differences, maximum character counts, and published free-generation conditions.

Practical synthesis includes the proposed anime character examples, scene layouts, hand/prop descriptions and the recommendation to alter one meaningful variable at a time. These are candidate writing decisions, not claims that longer or more anatomically detailed prompts improve NovelAI output. These follow the documented mechanics and normal visual reasoning; they are not an official "best prompt" or a guarantee that every ordinary descriptor is a known tag.

The general examples cover anime characters and interactions, illustrated environments, animals, still life, nonhuman assets, lettering and pixel art. Subject and gender follow the actual user's brief; the general guides carry one shared method. Historical test subjects or permissions do not become instructions or authorization for a future user.

The project's other research streams inspected the [V5 release announcement](https://blognew.novelai.net/image-generation-novelai-diffusion-v5-is-here-c2df7c6b8d2d/) and the [official image generator](https://novelai.net/image). Twelve gallery images in the announcement yielded actual alpha-channel stealth metadata; the other inspected announcement assets did not all retain prompt metadata. No missing prompts were invented. The repository preserves this evidence in unbundled upstream metadata records.

The official image generator's historical [quickstart JavaScript bundle](https://novelai.net/_next/static/chunks/5285-84437ecf40a2e4bf.js) yielded 81 complete V5 metadata entries by upstream static parsing. The [two-character interaction sample 0120](https://static.novelai.net/quickstart/v5/0120.webp) demonstrates separate identities and `mutual#fist bump`, as discussed in [examples.md](examples.md). The extraction remains an unbundled upstream record. Embedded official quickstart metadata is not a claim that every served WebP contains all parameters or that a historical hash URL remains current.

The same data was reviewed across subject matter, rather than only through the male subset: [Q0096](https://static.novelai.net/quickstart/v5/0096.webp) is cake still life; [Q0074](https://static.novelai.net/quickstart/v5/0074.webp) describes a cat on a pillow on grass; [Q0099](https://static.novelai.net/quickstart/v5/0099.webp) uses a duck, water, and reflection; [Q0098](https://static.novelai.net/quickstart/v5/0098.webp) depicts an anthropomorphic frog; [Q0115](https://static.novelai.net/quickstart/v5/0115.webp) assigns lettering to a blackboard. The announcement gallery also includes environment-led, creature, multilingual, and comic examples. The unbundled upstream pattern audit records those exact metadata fragments and their limits. They support broad subject coverage, not precision architecture/product guarantees.

Active community API repositories and the official web client's request-building code are additional evidence streams maintained by the project. Their observed payloads can validate runtime API fields; a single attractive image cannot establish that one prompt tag or sampler caused its quality. When making a new claim from those streams, record the original URL/file, model, actual prompt/settings, and whether it was directly inspected or inferred.

## User-specified community reference

Reviewed [Miint-Sunny/nai5-prompting](https://github.com/Miint-Sunny/nai5-prompting) at commit [`b32c9816fe028db251a1cf00712699eb2d706b09`](https://github.com/Miint-Sunny/nai5-prompting/tree/b32c9816fe028db251a1cf00712699eb2d706b09), 2026-09-19. The skill entrypoint, README, release notes, provenance notes, and complete combined method were read, with the conception and writing sections independently reviewed. The upstream source is GPL-3.0-only and remains an unmodified research snapshot with its notice/license; this skill does not bundle its text or import its operating instructions.

Useful ideas were independently expressed as practical heuristics: choose the actual deliverable first; turn abstract mood into visible relationships; use concise category/pose anchors plus prose for relations; keep component material/color/shape together; specify contact and current object state; place text on a definite carrier; preserve already supplied identity/design facts when making local edits. These are writing/design methods, not newly discovered API mechanics or measured success rates.

We did **not** adopt unsupported universal claims about V5 versus V4.5 weight equivalence, numerical doubling from repeated tags, Y coordinates as a guaranteed depth channel, complexity tags as compute-budget controls, ASCII-only V5 character recognition, or placing `has alpha` after particles as a required syntax. We also did not adopt the author's fixed formatting, female-first examples, private OC lookup assumptions, mandatory comic approval stages, or personal defaults. Its 28-step recommendation and suggestion of V5 Variety+ do not override this service's verified 23-step default and V4.5-only Variety Boost support.

The [official V5 page](https://novelai.net/v5) was newly read to cross-check its quote-to-text claim: it explicitly says the **frontend** builds `Text:` from quotes. The plugin deliberately uses the explicit `text` field and does not pretend to inherit that UI transform. English/Japanese are the page's primary supported languages; Chinese/German/Spanish/Portuguese are described as usable in testing with potentially less consistency. The image-text and prompt-language claims should not be conflated.

Community cited tag-API documentation at Safebooru returned 403, and a direct single-thighhigh wiki fetch failed; these pages are not marked successfully verified. The linked public [Danbooru Tag model source](https://github.com/danbooru/danbooru/blob/master/app/models/tag.rb) was accessible and confirms tag lookup/filter fields, not NovelAI training membership or generation success. The community's private small-sample experiment logs are not distributed, so those outcomes could not be independently reproduced. Detailed dispositions and access records are in unbundled upstream community-review records.

**Direct API billing evidence (2026-09-20):** Small-image live tests found direct 512px background removal cost 20, while the website-style estimate of 65 includes enlarging that input to about 1MP. V4.5 Full and Curated each charged 5 for one Precise Reference on an otherwise free Opus sample. The runtime quote now accounts for submitted dimensions and preserves the verified base discount, rather than retaining the initial conservative estimates. Detailed receipts and test scope are in the project validation report.

**Official tag suggestions:** The current image editor calls `GET /ai/generate-image/suggest-tags` with `model`, a short `prompt` fragment, `type=animev5` for V5, and optional `lang=jp`. The tool mirrors this read-only query and normalizes English/Japanese response shapes. Both queries were checked live without image generation; suggestions are not semantic or quality guarantees. The caller is in the official `266-9080def4f2212ae0.js` editor module.

## 2026-09-20 vocabulary and domain audit

The guide was audited across all sections against official documentation, 93 official example metadata records, 56 public tag/alias records and 15 wiki definitions. The public metadata was accessed through Safebooru's Danbooru application endpoint after the Danbooru hostname failed TLS. This verifies a current index, not NovelAI's training inventory. Exact queries, URLs and initial guide snapshots are retained in the unbundled upstream prompt-audit archive in the source project.

Key corrections: no compulsory `adult man`/numerical-age clauses; anime illustration as the default domain; clearly separated canonical tags, NovelAI custom tags, observed example fragments and ordinary language; no mandatory prose paragraph; no blanket prohibition on positioning objects in character slots; no universal full-body rule to disable the Curated quality preset. Current tag aliases do not rewrite exact official preset strings. `mature male` means middle-aged/older in the current wiki and is not a replacement for every adult; `mature` alone aliases to `mature_female`.

The official Quality Tags page still lists V4.5 suffixes with `location`. The inspected frontend and this service's current presets omit that term and add `very aesthetic` to the Curated suffix. The model guide now shows what this service actually compiles and names the documentation discrepancy, instead of presenting conflicting versions as the same template.

Six paired single-phrase trials (three seeds each for V5 Full and V4.5 Full) and two paired whole-template trials were generated at fixed per-pair settings and inspected. The phrase changed age impression and facial proportions; the old full template added stronger mature/semirealistic cues. All remained illustrations in this small sample. These observations do not establish a hidden base-model switch, universal performance, or a ban on natural language. Full prompts, seeds, settings, blind visual review and limitations are in the audit report. Schema/API tests are separate from this visual evidence.

## 2026-09-20 broader optimization review

Nine community repositories were compared at recorded commits, including [MCP-NovelAI](https://github.com/hesoyamlp1/MCP-NovelAI), [NovelAI_MCP](https://github.com/2332239652/NovelAI_MCP), [syou6162/novelai-mcp](https://github.com/syou6162/novelai-mcp), and a [DeepSeek Harness integration](https://github.com/issactravis579-bit/dsh-novelai-image). Useful requirements led to independent implementations of local image/mask preparation and optional text-only historical tool results. No third-party mirror routing, fixed character genders, compulsory UC, unverified price formulas, GPL text or unlicensed code was imported. Exact source files and license/activity checks are recorded in the project's unbundled upstream repository-review records.

A separate 52-image V5 matrix tested prompt forms, CFG, framing, UC and alpha on Full and Curated; eight additional V5 edits checked prepared-input workflows. Prompts/settings, blind observations, pixel measurements and limitations are preserved in the unbundled upstream optimization report and local receipts. These are small subject-specific experiments; they do not establish an overall best model, syntax or CFG. Alpha coverage and unchanged pixels outside an inpaint mask are measured facts, while composition and visual preference remain observational.

## v0.4.0 implementation and visual follow-up

The transparent-background checkbox was traced through official frontend modules 63509 and 15512: it adds the plain tag to the selected quality suffix, even for `none`, and sends the corresponding hint. Four controlled pairs had identical RGB pixels to manually adding the same tag; no extra visual boost is claimed. The official text delimiter in module 46278 is case-insensitive with boundaries, which the compiler now follows.

The next separately authorized round recorded 70 attempts, 69 confirmed images and zero Anlas; one early failed call had no saved generation receipt and was counted conservatively. It covered lettering, complexity, quality presets, action/framing, focused repair and outpainting. Short lettering succeeded in eight samples; naming a carrier controlled placement more clearly. A revised whole-body action recipe improved coverage, but precise fist contact and clothing still varied. Ten inpaint/outpaint outputs preserved every unselected original RGBA pixel. Original plans, blind observations, receipts and limits are recorded in the project's unbundled upstream visual-follow-up report. These observations refine examples without imposing a universal syntax, style or preset.

Receipt recovery distinguishes explicit model IDs from version-specific model hashes observed in this project's own successful requests. Unknown hashes are not extrapolated. Ordinary input metadata chunks are removed, but source alpha pixels are preserved and may carry hidden metadata; input preparation is not anonymization. Composited inpaint outputs preserve actual API text metadata when present and otherwise embed the compiled request to prevent old source alpha metadata from masquerading as the new operation.

## v0.4.1 named-character and artist comparisons

A separate 50-image V5 round tested Gojo Satoru, Zhongli, Gojo/Geto and Gojo/Zhongli pairs, plus `artist:ask (askzy)`, `artist:wlop` and their combination. The main 48-image matrix uses two seeds on both Full and Curated; two further images probe a weighted mixture at one seed. All completed at zero Anlas. Independent reviewers saw anonymous images and visual goals, not the prompt variants. Character recognition/ownership held in this sample; artist cues changed rendering as well as faces/clothing. Exact costume reconstruction, artist-original similarity, rare names and larger casts were not established.

The official autocomplete returned character names but omitted the tested artists. Both artist names are present as category-1 entries in the cached Danbooru vocabulary; their omission did not prevent visible V5 effects. Treat that index as a convenience, not a whitelist. The official [Prompt Mixing page](https://docs.novelai.net/en/image/promptmixing) limits its `|` syntax to V3 and older; V5 artist combinations use ordinary prompt cues with optional emphasis. See [characters-artists.md](characters-artists.md) for the practical workflow and the source project's unbundled upstream character/artist comparison report for requests and limitations.
