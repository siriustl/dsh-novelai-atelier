# NovelAI illustration prompt examples

> Evidence provenance: image observations and schema checks described here are retained upstream historical evidence. The requests remain authored starting points, not universal recipes. Use current offline validation and inspect actual authorized outputs; an earlier observation does not establish a new visual result.

These are authored starting points for anime, game, and stylized illustration. They cover environments, objects, animals, characters, interaction, lettering, and pixel art. All 12 have been checked against the request schema. Examples 1, 3, and 4 have local visual observations below; example 3 was revised after further paired tests. These checks do not establish universal visual success. Adapt the subject, presentation, and style to the actual brief; gender and age are not template fields to invent.

Each JSON block is a request object. Pass it to `nai_generate_image` as `{"request": <object>}` for an authorized image. Offline validation is optional via `nai_quote` with `offline:true` and `operation:"generate"`. Omitted settings use 23 steps, Euler Ancestral, Karras, and guidance 7 for V5 or 5 for V4.5. These sizes fit the normal single-image free envelope, but live entitlement still applies; generation can incur Anlas.

The examples combine documented NovelAI controls, familiar tag vocabulary, and clearly identified authored descriptions. A natural-language phrase need not be in Danbooru; do not call every comma-separated phrase a canonical tag. Most simple examples need no sentence at all. V5 can also handle much more substantial natural-language prompts when the task benefits; V4.5 supports natural language too.

The service adds standard quality and Heavy UC unless changed below. Do not repeat those automatic words in custom positives/negatives. Alternatives address possible conflicts: V5 Heavy lists dithering and negative space in UC; V4.5 Curated quality applies negative weight to feet. Consult `nai_get_presets` when adapting a style, since the same preset name has different content across models. A text-level conflict is a reason to compare outputs, not proof that a preset caused a visual failure.

## 1. V5 Full — a fantasy male portrait

```json
{
  "model": "nai-diffusion-5-full",
  "prompt": "1boy, solo, bishounen, attractive male, long hair, white hair, parted bangs, purple eyes, earrings, black coat, high collar, upper body, looking at viewer, light smile, anime coloring, simple background",
  "width": 832,
  "height": 1216,
  "seed": 51008
}
```

This particular design requests an elegant pretty-boy presentation. `attractive male` is a documented V5-specific cue, while `bishounen` is a vocabulary choice for the requested appearance. Neither is required for all men or establishes age. There is no default `adult man`, numerical age, broad-shoulder, facial-hair, or photographic-skin clause.

The local sample at seed 51008 showed an anime character with the requested white hair, purple eyes, earrings and black high-collar outfit. This is a single sample, not evidence that either beauty cue is necessary.

## 2. V4.5 Full — a character tending plants

```json
{
  "model": "nai-diffusion-4-5-full",
  "prompt": "1girl, solo, short hair, curly hair, brown hair, brown eyes, overalls, white shirt, short sleeves, upper body, potted plant, garden, smile, anime coloring. She holds the plant pot in both hands in front of her chest.",
  "width": 832,
  "height": 1216,
  "seed": 51009
}
```

This example uses a female character because that is its chosen subject, not a global default. The authored sentence connects hands and prop; it demonstrates that V4.5 also accepts natural-language action descriptions. Omit or change it when the desired pose differs.

## 3. V5 Full — two characters sharing an action

```json
{
  "model": "nai-diffusion-5-full",
  "prompt": "2boys, full body, standing, outdoors, pavement, brick wall, blue sky, anime coloring. The black-haired character is on the left and the brown-haired character is on the right. They face each other and touch the front knuckles of one closed fist each. Their arms reach horizontally into the space between them.",
  "width": 1024,
  "height": 1024,
  "characters": [
    {
      "prompt": "boy, short hair, black hair, blue eyes, leather jacket, grin"
    },
    {
      "prompt": "boy, messy hair, brown hair, green eyes, white shirt, smile",
      "negative_prompt": "jacket, coat"
    }
  ],
  "seed": 730011
}
```

Official [0120](https://static.novelai.net/quickstart/v5/0120.webp) demonstrates two character prompts with `mutual#fist bump`. The revised authored example above uses ordinary prose for the contact and automatic positioning. In local tests with two seeds per V5 model, a fuller framing and horizontally reaching arms made the shared action easier to read than the earlier cropped, parallel-fist pose. Adding the official action prefix was also tested; neither form was a universal winner.

Several factors changed together from the earlier recipe: framing, spatial relation, positioning mode and right-character UC. This is an improved example for this brief, not a claim that one sentence or tag caused every change. The local `jacket, coat` negative addresses that character's unwanted outerwear without suppressing the left character's jacket; extra outerwear still appeared in some seeds. Inspect contact, finger anatomy, framing and clothing before accepting a result.

## 4. V4.5 Curated — full-body male outfit

```json
{
  "model": "nai-diffusion-4-5-curated",
  "prompt": "1boy, solo, short hair, black hair, blue eyes, blue coat, high collar, white shirt, black pants, gloves, boots, standing, full body, simple background, anime coloring, very aesthetic, masterpiece, no text, rating:general",
  "negative_prompt": "cropped",
  "width": 832,
  "height": 1216,
  "quality_preset": "none",
  "seed": 51010
}
```

The Curated standard quality suffix contains `-0.8::feet::`. This example deliberately demonstrates replacing it with the other desired suffix terms to remove that negative weighting while asking to show boots. This is optional, not a requirement for every full-body request: the weighting does not directly specify geometric cropping, and its actual effect needs comparison. Heavy UC remains enabled; the only added negative targets cropping.

The local sample at seed 51010 showed the full blue-coat outfit and boots. No preset A/B comparison was performed, so that result does not establish that removing the feet weighting caused success.

## 5. V5 Full — visual-novel landscape

```json
{
  "model": "nai-diffusion-5-full",
  "prompt": "no humans, scenery, visual novel bg, lake, mountain, forest, sunrise, cloud, reflection. A narrow path follows the near shore; the mountains rise beyond the lake.",
  "width": 1216,
  "height": 832,
  "seed": 51001
}
```

`visual novel bg` is a documented V5-specific tag. The final sentence is an authored spatial description. `background dataset` is intentionally absent: the official documentation describes it as steering toward photographic nonhuman imagery, so it is not the generic switch for an anime background.

## 6. V5 Curated — overgrown fantasy architecture

```json
{
  "model": "nai-diffusion-5-curated",
  "prompt": "no humans, scenery, ruins, castle, arch, stairs, ivy, overgrown, fantasy, traditional media, watercolor (medium). The stairs pass beneath the arch and disappear into the ruined courtyard.",
  "width": 1216,
  "height": 832,
  "seed": 51002
}
```

The tags identify visible forms and a medium; the optional sentence supplies a route through the picture. This is an environment illustration, not an architectural blueprint. Standard quality is kept as a starting point; compare a different preset only if it visibly competes with the desired watercolor style.

## 7. V4.5 Full — animal illustration

```json
{
  "model": "nai-diffusion-4-5-full",
  "prompt": "no humans, animal focus, fox, sitting, looking back, snow, forest, traditional media, watercolor (medium)",
  "width": 1024,
  "height": 1024,
  "seed": 51003
}
```

A short tag list gives species, pose, environment, and medium. There is no requirement to append an English paragraph. V4.5 could use a sentence if a specific interaction or composition needed one; it simply does not here.

## 8. V5 Curated — illustrated dessert

```json
{
  "model": "nai-diffusion-5-curated",
  "prompt": "no humans, food focus, cake slice, strawberry, plate, flower, pastel colors, simple background, flat color",
  "width": 1024,
  "height": 1024,
  "seed": 51004
}
```

Official quickstart [0096](https://static.novelai.net/quickstart/v5/0096.webp) also combines a cake slice, flowers, and an illustrative finish. This is a simplified authored variation, not a reconstruction of that image. Product photography and studio render terminology are unnecessary for this brief.

## 9. V4.5 Curated — still-life illustration

```json
{
  "model": "nai-diffusion-4-5-curated",
  "prompt": "no humans, still life, teapot, teacup, bread, wooden table, window, sunlight, anime coloring",
  "width": 1024,
  "height": 1024,
  "seed": 51005
}
```

Objects and a room detail can be prompted without a human character. Keeping the default quality preset here does not conflict with a feet requirement, because there is none. This does not prove the preset is optimal for still lifes; it illustrates that a preset need not be disabled merely because the subject is nonhuman.

## 10. V5 Full — a chalkboard with lettering

```json
{
  "model": "nai-diffusion-5-full",
  "prompt": "no humans, blackboard, chalk, english text, text, lineart. The words are written in large white chalk letters at the center of the blackboard.",
  "width": 1216,
  "height": 832,
  "negative_preset": "light",
  "text": "See you tomorrow!",
  "seed": 51006
}
```

Official [0115](https://static.novelai.net/quickstart/v5/0115.webp) supplies evidence for `blackboard`, `english text`, `text`, and a sentence about chalk lettering, even if a separate vocabulary snapshot omits some terms. This authored example removes the person and specifies a carrier and text region. The service compiles the `text` field into a final `Text:` block and removes automatic `no text`. V5 Light avoids Heavy's `negative space`, which could compete with a sparse board. Verify the spelling in the output.

## 11. V5 Curated — transparent robot asset

```json
{
  "model": "nai-diffusion-5-curated",
  "prompt": "no humans, robot, chibi, full body, waving, mechanical arms, lineart, flat color, transparent background, low complexity. The robot has a round cream body, two blue eyes, and two wheels.",
  "width": 832,
  "height": 1216,
  "negative_preset": "light",
  "seed": 51007
}
```

True alpha transparency and complexity tags are documented V5 features. The robot description is ordinary language, not a claim about special tags. Light omits the Heavy preset's `negative space` term; this is a template choice to compare, not a proven alpha improvement; inspect actual alpha, cropping, and wheel count. A transparent prompt does not guarantee a production-ready sprite.

## 12. V5 Curated — pixel-art forest path

```json
{
  "model": "nai-diffusion-5-curated",
  "prompt": "no humans, scenery, forest, path, lantern, night, pixel art, dithering, limited palette",
  "width": 1024,
  "height": 1024,
  "quality_preset": "none",
  "negative_preset": "none",
  "negative_prompt": "jpeg artifacts, watermark",
  "seed": 51012
}
```

The official art-style tutorial suggests combining `pixel art` and `dithering`. V5 Heavy explicitly excludes dithering, so this example uses targeted custom negatives; automatic aesthetic quality is also off to compare the requested medium without that style bias. This still generates a normal-sized image with pixel-art appearance, not a guaranteed exact low-resolution tile grid. No language sentence is needed to fill a supposed template slot.

## Revisions and limits

Hold seed, model, dimensions, and settings fixed for a specific comparison. Change one useful cause: a confusing pose, misplaced object, style conflict, preset choice, or missing identity feature. Inspect the result before declaring an improvement; a valid request is not evidence of good anatomy, faithful design, correct lettering, or attractive composition.

Scene and object examples above use the base prompt because their layouts are simple. Character-prompt slots can also position objects, as the official multi-character guide describes; use that capability when it helps a more structured layout. Avoid forcing a human count or identity template onto scenery, objects, or creatures.

Sources: [official tagging](https://docs.novelai.net/en/image/tags), [art styles](https://docs.novelai.net/en/image/tutorial-artstyles), [model differences](https://docs.novelai.net/en/image/models), [multi-character prompting](https://docs.novelai.net/en/image/multiplecharacters), and the linked official image examples. Historical local observations were reported in the unbundled upstream audit. The request examples can be validated offline with the current tools; that does not reproduce their historical image results.
