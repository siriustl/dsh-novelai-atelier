import { z } from 'zod'

/** One portable directory segment, relative to the configured output directory. */
export const OutputSubdirSchema = z.string().trim().min(1).max(100).refine((value) => {
  if (/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value) || /[. ]$/u.test(value)) return false
  if (/^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(value)) return false
  return value !== '.' && value !== '..'
}, 'Use a single valid output directory name, not a path or reserved device name')
