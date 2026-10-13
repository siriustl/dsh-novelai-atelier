/** Operation field catalogue served to the workbench UI (schema endpoint). */

export function describeOperation(): Record<string, unknown> {
  const generate = {
    model: { type: 'enum', options: ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'], default: 'nai-diffusion-5-full' },
    prompt: { type: 'string', default: '' },
    negative_prompt: { type: 'string', default: '' },
    width: { type: 'integer', default: 832, min: 64, max: 4096, step: 64 },
    height: { type: 'integer', default: 1216, min: 64, max: 4096, step: 64 },
    steps: { type: 'integer', min: 1, max: 50, nullable: true },
    scale: { type: 'number', min: 0, max: 10, nullable: true },
    seed: { type: 'integer', min: 0, max: 4294967295, nullable: true },
    sampler: { type: 'enum', options: ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_sde'], default: 'k_euler_ancestral' },
    noise_schedule: { type: 'enum', options: ['karras', 'exponential', 'polyexponential'], default: 'karras' },
    cfg_rescale: { type: 'number', min: 0, max: 1, default: 0 },
    quality_preset: { type: 'enum', options: ['standard', 'light', 'none'], default: 'standard' },
    negative_preset: { type: 'enum', options: ['heavy', 'light', 'humanFocus', 'furryFocus', 'none'], default: 'heavy' },
    characters: { type: 'array', max: 22, item: { prompt: { type: 'string' }, negative_prompt: { type: 'string' }, x: { type: 'number', nullable: true }, y: { type: 'number', nullable: true } } },
    variety_boost: { type: 'boolean', default: false, note: '仅 V4.5' },
    transparent_background: { type: 'boolean', default: false, note: '仅 V5' },
    text: { type: 'string', nullable: true, max: 750 },
  }
  const withImage = (extra: Record<string, unknown>) => ({
    ...generate,
    image_path: { type: 'string', required: true },
    ...extra,
  })
  return {
    operations: {
      generate,
      img2img: withImage({ strength: { type: 'number', min: 0.01, max: 0.99, default: 0.7 }, noise: { type: 'number', min: 0, max: 0.99, default: 0 }, extra_noise_seed: { type: 'integer', nullable: true }, color_correct: { type: 'boolean', default: false } }),
      enhance: withImage({ strength: { type: 'number', min: 0.01, max: 0.99, default: 0.2 }, noise: { type: 'number', min: 0, max: 0.99, default: 0 }, extra_noise_seed: { type: 'integer', nullable: true }, color_correct: { type: 'boolean', default: false }, mode: { type: 'enum', options: ['regular', 'max'], default: 'regular', note: 'max 仅 V5' }, append_enhance_tags: { type: 'boolean', default: true } }),
      inpaint: { ...withImage({ mask_path: { type: 'string', required: true }, mask_mode: { type: 'enum', options: ['luminance', 'alpha'], default: 'luminance' }, strength: { type: 'number', min: 0, max: 1, default: 1 }, extra_noise_seed: { type: 'integer', nullable: true }, color_correct: { type: 'boolean', default: true }, focus_box: { type: 'array', note: '[l,t,r,b]，可选聚焦放大' }, focus_size: { type: 'array', note: '[w,h]，64 倍数' } }), model: { type: 'enum', options: ['nai-diffusion-5-full', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'], default: 'nai-diffusion-5-full' } },
      upscale: { image_path: { type: 'string', required: true }, model: { type: 'string', default: 'nai-diffusion-5-curated' } },
      augment: { image_path: { type: 'string', required: true }, tool: { type: 'enum', options: ['bg-removal', 'lineart', 'sketch', 'colorize', 'emotion', 'declutter', 'declutter-keep-bubbles'] }, prompt: { type: 'string', default: '' }, defry: { type: 'integer', min: 0, max: 5, default: 0 }, emotion: { type: 'string', nullable: true } },
      encode_vibe: { image_path: { type: 'string', required: true }, model: { type: 'enum', options: ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'], default: 'nai-diffusion-4-5-full' }, information_extracted: { type: 'number', min: 0.01, max: 1, default: 0.7 } },
      reference_generate: { ...generate, model: { type: 'enum', options: ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'], default: 'nai-diffusion-4-5-full' }, vibes: { type: 'array', max: 16, item: { encoding_path: { type: 'string' }, strength: { type: 'number', default: 0.6 }, information_extracted: { type: 'number', nullable: true } } }, precise_references: { type: 'array', max: 16, item: { image_path: { type: 'string' }, type: { type: 'enum', options: ['character', 'style', 'character&style'], default: 'character' }, strength: { type: 'number', default: 1 }, fidelity: { type: 'number', default: 1 } } }, normalize_vibe_strengths: { type: 'boolean', default: true }, note: 'vibes 与 precise_references 不可混用' },
      prepare_image: { image_path: { type: 'string', required: true }, width: { type: 'integer', nullable: true, min: 64, max: 4096, step: 64 }, height: { type: 'integer', nullable: true, min: 64, max: 4096, step: 64 }, mode: { type: 'enum', options: ['contain', 'cover', 'stretch', 'pad'], default: 'contain' }, background: { type: 'string', default: '#ffffff' }, crop_box: { type: 'array', note: '[l,t,r,b]' }, mask_boxes: { type: 'array' }, mask_polygons: { type: 'array' } },
    },
    models: ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'],
    samplers: ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_sde'],
  }
}
