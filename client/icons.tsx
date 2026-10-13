/** Shared Lucide symbols; React is provided by the host module factory. */
import { Brush, Image, Layers, SlidersHorizontal, Sparkles, Library, Files, Calendar, Settings2, Play, Pause, Plus, Trash2, Pencil, Copy, Save, RefreshCw, Download, Upload, X, Undo2, Eraser, Check, AlertTriangle, Coins, Maximize2, Search, ChevronLeft, ChevronRight, List, Users, FolderOpen, Eye, LoaderCircle, Clock, Star, Grid2X2, Columns2 } from 'lucide-react'
import { createElement } from 'react'
import type { Rec } from './api.ts'

const symbols = {
  brush: Brush, image: Image, layers: Layers, sliders: SlidersHorizontal, sparkles: Sparkles,
  library: Library, files: Files, calendar: Calendar, settings: Settings2, play: Play, pause: Pause,
  plus: Plus, trash: Trash2, edit: Pencil, copy: Copy, save: Save, refresh: RefreshCw,
  download: Download, upload: Upload, close: X, undo: Undo2, eraser: Eraser, check: Check,
  alert: AlertTriangle, coins: Coins, expand: Maximize2, search: Search,
  previous: ChevronLeft, next: ChevronRight, list: List, users: Users, folder: FolderOpen,
  eye: Eye, loader: LoaderCircle, clock: Clock, star: Star, grid: Grid2X2, columns: Columns2,
} as const
export type IconName = keyof typeof symbols

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }): Rec {
  return createElement(symbols[name], { size, style: { width: size, height: size }, strokeWidth: 1.75, className: `nai-icon ${className}`, 'aria-hidden': true, focusable: false }) as unknown as Rec
}

export function commandPresentation(text: string): { label: string; icon?: IconName } {
  const prefixes: Array<[string, IconName]> = [
    ['＋', 'plus'], ['⬇', 'download'], ['⬆', 'upload'], ['✎', 'edit'], ['⧉', 'copy'],
    ['⤵', 'copy'], ['▶', 'play'], ['⏸', 'pause'], ['⏱', 'clock'], ['☰', 'list'],
    ['📋', 'copy'], ['🎨', 'image'], ['🖌️', 'brush'], ['🔍', 'expand'], ['👤', 'users'],
    ['⚙', 'sliders'], ['★', 'star'], ['☆', 'star'], ['✕', 'close'],
  ]
  const candidate = prefixes.find(([value]) => text.startsWith(value))
  const commandPrefix = /^(?:新建|添加|上传|选择|导出|导入|编辑|复制|分支|从资料库|画师混合|立即执行|执行记录|暂停|启用|填入草稿|绘制|准备画布|保存|应用|发送|查看|存为|下载|取消|收藏|本体|角色本体)/u
  const prefix = candidate && commandPrefix.test(text.slice(candidate[0].length).trimStart()) ? candidate : undefined
  const label = (prefix ? text.slice(prefix[0].length).trimStart() : text).replace(/\s+▸$/u, '')
  const commands: Array<[RegExp, IconName]> = [
    [/^(?:生成|开始生成|开始编码|开始放大|加入队列)/u, 'play'], [/^(?:保存|另存)/u, 'save'],
    [/^(?:清空|重置|重新载入|恢复默认)/u, 'undo'], [/^刷新/u, 'refresh'], [/^复制/u, 'copy'],
    [/^(?:撤销)/u, 'undo'], [/^(?:画笔|绘制遮罩|重新绘制遮罩)/u, 'brush'], [/^橡皮/u, 'eraser'],
    [/^(?:校验|测试)/u, 'check'], [/^费用/u, 'coins'], [/^(?:查看参数|参数对照)/u, 'sliders'],
    [/^上一页/u, 'previous'], [/^下一页/u, 'next'], [/^(?:关闭|取消)/u, 'close'],
    [/^打开所在文件夹/u, 'folder'], [/^用作 Vibe/u, 'layers'], [/^下载/u, 'download'], [/^导出/u, 'download'], [/^导入/u, 'upload'],
  ]
  return { label, icon: prefix?.[1] ?? commands.find(([pattern]) => pattern.test(label))?.[1] }
}
