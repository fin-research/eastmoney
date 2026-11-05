// macOS Vision 验证码识别：swift captcha-ocr.swift 图片... ；每行输出 文件名\t变体1\t变体2\t变体3\t变体4（放大/灰度对比度变体各识别一次，由调用方投票）
import AppKit
import Vision
import CoreImage

func variants(_ cg: CGImage) -> [CGImage] {
    let ci = CIImage(cgImage: cg)
    let ctx = CIContext()
    var out: [CGImage] = []
    for scale in [3.0, 5.0] {
        let up = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        // padded white border helps Vision
        let pad = CIImage(color: .white).cropped(to: up.extent.insetBy(dx: -30, dy: -30))
        let comp = up.composited(over: pad)
        if let a = ctx.createCGImage(comp, from: comp.extent) { out.append(a) }
        if let f = CIFilter(name: "CIColorControls", parameters: [kCIInputImageKey: comp, kCIInputSaturationKey: 0.0, kCIInputContrastKey: 1.8]),
           let o = f.outputImage, let a = ctx.createCGImage(o, from: o.extent) { out.append(a) }
    }
    return out
}
for path in CommandLine.arguments.dropFirst() {
    guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("\(path)\tERR"); continue }
    var results: [String] = []
    for v in variants(cg) {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false
        req.recognitionLanguages = ["en-US"]
        try? VNImageRequestHandler(cgImage: v).perform([req])
        let t = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined().filter { $0.isLetter || $0.isNumber }
        results.append(t)
    }
    print("\((path as NSString).lastPathComponent)\t\(results.joined(separator: "\t"))")
}
