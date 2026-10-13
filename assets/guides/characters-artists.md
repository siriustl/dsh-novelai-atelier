# Named characters and artist tags

> Evidence provenance: dated character/artist comparisons are retained upstream historical experiments with a narrow scene and seed set. They are practical observations, not official guarantees of recognition or style. The source archive is not bundled; do not infer access to its private files.

Use this page for existing named characters, character branches (including alternate outfits, forms or eras), single artist tags, and artist combinations. These methods apply across subject genders. The image comparisons described below cover V5 Full and Curated; do not assume identical behavior on V4.5.

## Start from the tag, not an autocomplete whitelist

Danbooru character and artist tags are useful starting vocabulary for NovelAI. Use the actual spelling and disambiguating parenthesis rather than inventing an English translation from a Chinese display name. For example, the character tag is `zhongli (genshin impact)`; a local library can display 钟离 while retaining that prompt text separately. Convert dataset underscores to normal prompt spaces where appropriate. Do not translate or remove the meaningful parenthesis.

The official suggestion index is not a complete list of usable names. In the local V5 checks it returned exact character matches, but did not return the tested `ask (askzy)` and `wlop` artists. Both have artist-category entries in the cached Danbooru vocabulary, and their V5 image comparisons changed visibly. Missing autocomplete is not a reason to reject a Danbooru artist or character tag. Conversely, a matching name/count does not guarantee exact design reproduction in every composition or model.

For a requested artist, use the explicit namespace, e.g. `artist:ask (askzy)` or `artist:wlop`. Parentheses here disambiguate the name; they are not Stable Diffusion weights. Preserve a user-supplied artist string instead of silently replacing it with a preferred recipe. Do not add artists to every prompt or guess an artist solely from an image's general appearance.

## One named character

Start with the name, relevant franchise when helpful, count and the requested scene:

```text
1boy, solo, zhongli (genshin impact), genshin impact, upper body, looking at viewer, slight smile, simple background
```

This is a compact tested starting point, not a complete costume specification. Inspect recognition first: hair silhouette, eyes when visible, characteristic accessories, and recognizable clothing structure. If a particular detail is missing, add that detail. More generic hair/color/clothing words can also replace fine costume structure with an approximate outfit; more words do not inherently improve fidelity.

Separate identity from the selected branch. A branch can change clothing, form, era, role or other traits. For a library entry, store stable identity tags plus named branches and their prompt sets, then compose only the selected version. A modern casual outfit should replace the default costume tags; appending a hoodie while retaining armor or a uniform makes a conflicting request. Keep prompt edits local to the requested variant. An alternate official appearance can have its own named tag; confirm the exact variant rather than guessing a parenthetical suffix.

Do not require invisible identity features: eye color behind an opaque blindfold and boots in a portrait are not useful completion criteria. Exact continuity across separate generations needs image inspection; a shared name and seed are not an identity lock. V5 currently has no supported Vibe/Precise Reference workflow in this service; do not advertise those as a V5 character-consistency solution.

## Several named characters

Keep shared count, scene, framing, style and interaction in the base. Put each identity and outfit in its own character prompt. The official character count words remain `boy`/`girl`/`other` inside slots, with the total in the base.

```text
Base:
2boys, standing, side-by-side, upper body, outdoors, park, daytime. The white-haired character stands on the left; the dark-haired character stands on the right. Both look at the viewer.

Character 1:
boy, gojou satoru, jujutsu kaisen, white hair, black blindfold, high collar, black jacket

Character 2:
boy, zhongli (genshin impact), genshin impact, brown hair, long hair, ponytail, orange eyes, earrings, brown coat, black gloves
```

This adapts the tested crossover; the eye cue behind Gojo's blindfold is omitted. Maintain the same ordering in the library selection, prose, and any explicit coordinates. Automatic positioning is a valid starting point. Judge identities separately from positions: correct left/right placement can still contain the wrong face or borrowed coat. Slots improve organization and allow per-character UC; they are not a guarantee against attribute leakage. If a feature leaks, revise only the affected slot or its UC and compare again.

Two names in the shared prompt can work, especially recognizable pairs. Do not declare it invalid. Use separate slots when independent outfits, poses, exclusions or positions matter, and compare actual adherence rather than assuming a more elaborate request must win.

## One artist, then a controlled mixture

Place shared artist/style cues in the base so they apply to the illustration. Begin with one artist on a fixed scene; preserve default quality/UC for the first comparison unless the requested medium conflicts. Artist cues can change faces, apparent age, clothing, framing and background as well as brushwork. They are not a postprocessing filter.

For two artists, compare the no-artist scene, A alone, B alone, and A+B with the same model, seed and settings:

```text
artist:ask (askzy), artist:wlop, 1boy, solo, black hair, short hair, green eyes, earrings, white shirt, blue coat, upper body, looking at viewer, slight smile, outdoors, garden, sunlight
```

Two unweighted names do not establish a 50:50 blend. One can dominate, and order/scene/model can matter. When needed, use NAI numerical emphasis on individual cues:

```text
1.2::artist:ask (askzy)::, 0.6::artist:wlop::, ...
```

Those numbers are attention weights, not percentages, and do not need to sum to one. This is a mild exploratory combination, not an optimal recipe. Keep delimiters closed. Avoid concatenating a numeric-ending tag directly into a closing weight delimiter; put a comma before the delimiter when needed to keep boundaries clear.

Do not use `A|B` or `A:0.7|B:0.3` as a V5/V4.5 artist blend feature. The official legacy **Prompt Mixing** page explicitly limits that mechanism to V3 and older. Multiple artist cues and numerical emphasis in a current prompt are different from that legacy vector-mixing API. `<artist>`/`<style>` wrappers found in some community templates are human organization, not required NovelAI syntax.

Measure the desired result: line/edge treatment, shapes, shading, palette, and scene/identity fidelity. Without actual artist reference works, describe changes caused by the tested tag instead of claiming a faithful reproduction of the artist's entire style. Save a useful mixture with its ordered tag string, model, quality/UC, complete prompt, seed and representative images; a bare weight pair is insufficient to reproduce the example.

## Evidence and scope

The 2026-09-20 dedicated experiment fixes 23 steps, CFG 7, Euler Ancestral, Karras and standard quality/heavy UC. Its first 48 images compare two single named characters, a same-series pair and a crossover, and two artists plus their combination, each at two seeds on both V5 models. Character trials use default/explicit trait variants; pair trials keep the wording but move individual descriptions between shared prompt and automatic character slots. This is a small, deliberately narrow experiment, not a survey of all artists, franchises, alternate costumes or crowded scenes.

All 32 character images retained recognizable identities; the 16 double portraits preserved count and left/right ownership under both shared and separate prompts. Adding traits changed accessories and poses as well as visibility of identity cues. In particular, simultaneously requesting blue eyes and a black blindfold often produced a one-eye-peeking design. For a fully covered eye region, specify that design and omit an unnecessary eye-color request. A complete-cover wording revision was validated as a request, not visually proven in an additional generation.

In the 16 main artist images, ASK cues tended toward warmer, more graphic shading, WLOP cues toward more dimensional/glossy rendering, and combined cues changed face proportions and garment details too. These are observations of this fixed scene, not universal artist biographies. Two further images tested ASK 1.2/WLOP 0.6 at one seed per model; they changed the mixture but do not establish a generally optimal ratio. The complete round produced 50 images at zero Anlas.

Official syntax and version scope: [Basics](https://docs.novelai.net/en/image/basics), [Prompt Mixing](https://docs.novelai.net/en/image/promptmixing), and the model/character references in [sources.md](sources.md). Full plans, images and blinded observations were reported in the unbundled upstream research archive; this package retains the limited historical conclusions above, not those private files.
