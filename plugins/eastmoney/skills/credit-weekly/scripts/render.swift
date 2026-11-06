// 按版面描述（layout.mjs 生成的 JSON）绘制 PDF：每个页面缩放到一页 A4（只缩小不放大），水平垂直居中，左右 0 边距，上下各留 marginV。
// 用法：render <plan.json> <out.pdf>。只依赖 macOS 自带的 CoreGraphics / CoreText。
import Foundation
import CoreGraphics
import CoreText

struct Run: Decodable { let text: String; let name: String; let size: Double; let bold: Bool; let italic: Bool; let color: String }
struct Edge: Decodable { let w: Double; let color: String }
struct Cell: Decodable {
    let row: Int; let col: Int; let rs: Int; let cs: Int; let xl: Int; let xr: Int
    let runs: [Run]; let fill: String?
    let h: String; let v: String; let wrap: Bool
    let bl: Edge?; let br: Edge?; let bt: Edge?; let bb: Edge?
}
struct Page: Decodable { let cols: [Double]; let rows: [Double]; let cells: [Cell] }
struct Plan: Decodable { let pages: [Page] }

let pageW = 595.2756, pageH = 841.8898, pad = 3.0, marginV = 24.0, minLine = 0.75 // 线宽下限（页面上的点数），避免缩小后网格线在阅读器里时隐时现

func cgColor(_ hex: String) -> CGColor {
    let v = UInt32(hex.suffix(6), radix: 16) ?? 0
    return CGColor(red: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}

func fontName(_ name: String) -> String {
    switch name {
    case "SimSun", "宋体", "NSimSun", "新宋体": return "Songti SC"
    case "等线", "DengXian", "微软雅黑", "Microsoft YaHei", "黑体", "SimHei": return "PingFang SC"
    default: return name
    }
}

func attributed(_ runs: [Run], wrap: Bool, h: String) -> NSAttributedString {
    let out = NSMutableAttributedString()
    var align = CTTextAlignment.left
    if h == "center" || h == "centerContinuous" { align = .center } else if h == "right" { align = .right }
    var mode = wrap ? CTLineBreakMode.byWordWrapping : CTLineBreakMode.byClipping
    let style = withUnsafePointer(to: &align) { a in
        withUnsafePointer(to: &mode) { m -> CTParagraphStyle in
            var settings = [
                CTParagraphStyleSetting(spec: .alignment, valueSize: MemoryLayout<CTTextAlignment>.size, value: a),
                CTParagraphStyleSetting(spec: .lineBreakMode, valueSize: MemoryLayout<CTLineBreakMode>.size, value: m),
            ]
            return CTParagraphStyleCreate(&settings, settings.count)
        }
    }
    for r in runs {
        var font = CTFontCreateWithName(fontName(r.name) as CFString, CGFloat(r.size), nil)
        var traits: CTFontSymbolicTraits = []
        if r.bold { traits.insert(.boldTrait) }
        if r.italic { traits.insert(.italicTrait) }
        if !traits.isEmpty, let f = CTFontCreateCopyWithSymbolicTraits(font, CGFloat(r.size), nil, traits, traits) { font = f }
        let text = wrap ? r.text : r.text.replacingOccurrences(of: "\n", with: " ")
        out.append(NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): cgColor(r.color),
            NSAttributedString.Key(kCTParagraphStyleAttributeName as String): style,
        ]))
    }
    return out
}

func drawText(_ ctx: CGContext, _ cell: Cell, _ rect: CGRect) {
    guard cell.runs.contains(where: { !$0.text.isEmpty }) else { return }
    let text = attributed(cell.runs, wrap: cell.wrap, h: cell.h)
    let setter = CTFramesetterCreateWithAttributedString(text)
    let avail = max(rect.width - 2 * pad, 1)
    let measured = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(location: 0, length: 0), nil, CGSize(width: cell.wrap ? avail : 100000, height: 100000), nil)
    let textH = ceil(measured.height)
    let top: CGFloat = cell.v == "top" ? 0 : cell.v == "center" || cell.v == "distributed" || cell.v == "justify" ? (rect.height - textH) / 2 : rect.height - textH - 1
    ctx.saveGState()
    ctx.clip(to: rect)
    let overflow = measured.width - avail
    let shift: CGFloat = !cell.wrap && overflow > 0 ? (cell.h == "right" ? -overflow : cell.h == "center" ? -overflow / 2 : 0) : 0
    ctx.translateBy(x: rect.minX + pad + shift, y: rect.minY + max(top, 0) + textH)
    ctx.scaleBy(x: 1, y: -1) // 画布 y 向下，CoreText 需要 y 向上
    let path = CGPath(rect: CGRect(x: 0, y: 0, width: cell.wrap ? avail : max(measured.width, avail), height: textH + 1), transform: nil)
    CTFrameDraw(CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil), ctx)
    ctx.restoreGState()
}

func run(_ planPath: String, _ outPath: String) throws {
    let plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: URL(fileURLWithPath: planPath)))
    var box = CGRect(x: 0, y: 0, width: pageW, height: pageH)
    guard let ctx = CGContext(URL(fileURLWithPath: outPath) as CFURL, mediaBox: &box, nil) else { throw NSError(domain: "render", code: 1) }
    for page in plan.pages {
        let w = page.cols.reduce(0, +), h = page.rows.reduce(0, +)
        let s = min(pageW / w, (pageH - 2 * marginV) / h, 1)
        var xs = [0.0], ys = [0.0]
        for c in page.cols { xs.append(xs.last! + c) }
        for r in page.rows { ys.append(ys.last! + r) }
        func rect(_ c: Cell) -> CGRect {
            CGRect(x: xs[c.col], y: ys[c.row], width: xs[min(c.col + c.cs, page.cols.count)] - xs[c.col], height: ys[min(c.row + c.rs, page.rows.count)] - ys[c.row])
        }
        func textRect(_ c: Cell) -> CGRect {
            let r = rect(c), l = max(c.col - c.xl, 0), rr = min(c.col + c.cs + c.xr, page.cols.count)
            return CGRect(x: xs[l], y: r.minY, width: xs[rr] - xs[l], height: r.height)
        }
        ctx.beginPDFPage(nil)
        ctx.translateBy(x: (pageW - w * s) / 2, y: pageH - (pageH - h * s) / 2)
        ctx.scaleBy(x: s, y: -s)
        for c in page.cells { if let f = c.fill, rect(c).width > 0, rect(c).height > 0 { ctx.setFillColor(cgColor(f)); ctx.fill(rect(c)) } }
        for c in page.cells where rect(c).width > 0 && rect(c).height > 0 { drawText(ctx, c, textRect(c)) }
        // 相邻单元格对同一条边各有定义时（如合并格的右边框是黑色、右邻格的左边框是浅蓝），Excel 以深色粗线为准：
        // 先收集所有线段，浅色/细线先画，深色/粗线后画盖在上面。
        struct Seg { let e: Edge; let x1: CGFloat; let y1: CGFloat; let x2: CGFloat; let y2: CGFloat }
        var segs: [Seg] = []
        for c in page.cells {
            let r = rect(c)
            if r.width <= 0 || r.height <= 0 { continue }
            if let e = c.bt { segs.append(Seg(e: e, x1: r.minX, y1: r.minY, x2: r.maxX, y2: r.minY)) }
            if let e = c.bb { segs.append(Seg(e: e, x1: r.minX, y1: r.maxY, x2: r.maxX, y2: r.maxY)) }
            if let e = c.bl { segs.append(Seg(e: e, x1: r.minX, y1: r.minY, x2: r.minX, y2: r.maxY)) }
            if let e = c.br { segs.append(Seg(e: e, x1: r.maxX, y1: r.minY, x2: r.maxX, y2: r.maxY)) }
        }
        func luminance(_ hex: String) -> Double {
            let v = UInt32(hex.suffix(6), radix: 16) ?? 0
            return 0.299 * Double((v >> 16) & 255) + 0.587 * Double((v >> 8) & 255) + 0.114 * Double(v & 255)
        }
        segs.sort { a, b in a.e.w != b.e.w ? a.e.w < b.e.w : luminance(a.e.color) > luminance(b.e.color) }
        for g in segs {
            ctx.setStrokeColor(cgColor(g.e.color)); ctx.setLineWidth(max(g.e.w, minLine / s))
            ctx.move(to: CGPoint(x: g.x1, y: g.y1)); ctx.addLine(to: CGPoint(x: g.x2, y: g.y2)); ctx.strokePath()
        }
        ctx.endPDFPage()
    }
    ctx.closePDF()
}

let args = CommandLine.arguments
guard args.count == 3 else { FileHandle.standardError.write(Data("用法：render <plan.json> <out.pdf>\n".utf8)); exit(2) }
do { try run(args[1], args[2]) } catch { FileHandle.standardError.write(Data("渲染失败：\(error)\n".utf8)); exit(1) }
