import { petAssetUrl } from '../../shared/defaults'

export async function splitSpriteSheet(
  dataUrl: string,
  rows: number,
  cols: number,
  skipEmpty = true
): Promise<string[]> {
  const image = new Image()
  image.src = dataUrl
  await image.decode()
  const safeRows = Math.max(1, Math.min(40, Math.floor(rows)))
  const safeCols = Math.max(1, Math.min(40, Math.floor(cols)))
  const cellWidth = Math.floor(image.width / safeCols)
  const cellHeight = Math.floor(image.height / safeRows)
  if (cellWidth < 1 || cellHeight < 1) throw new Error('切分行列数不能超过图片尺寸')
  const frames: string[] = []
  for (let row = 0; row < safeRows; row += 1) {
    for (let col = 0; col < safeCols; col += 1) {
      const canvas = document.createElement('canvas')
      canvas.width = cellWidth
      canvas.height = cellHeight
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      ctx.drawImage(
        image,
        col * cellWidth,
        row * cellHeight,
        cellWidth,
        cellHeight,
        0,
        0,
        cellWidth,
        cellHeight
      )
      if (skipEmpty) {
        const data = ctx.getImageData(0, 0, cellWidth, cellHeight).data
        let visible = false
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 6) {
            visible = true
            break
          }
        }
        if (!visible) continue
      }
      frames.push(canvas.toDataURL('image/png'))
      if (frames.length >= 80) return frames
    }
  }
  return frames
}

export async function toDataUrl(src: string): Promise<string> {
  if (src.startsWith('data:')) return src
  const response = await fetch(src)
  if (!response.ok) throw new Error(`无法读取资源：${src}`)
  const blob = await response.blob()
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsDataURL(blob)
  })
}

export function assetUrl(petId: string, relativePath: string): string {
  return petAssetUrl(petId, relativePath)
}
