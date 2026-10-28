// macOS Vision OCR, preserving table rows by page coordinates. Read-only image input.
import Foundation
import Vision
import ImageIO

guard CommandLine.arguments.count == 2 else { fatalError("Usage: credit-ocr page.png") }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
request.minimumTextHeight = 0.003
request.customWords = ["东方财富证券", "吸收投资收到的现金", "取得借款收到的现金", "实收资本", "资本公积", "融资融券", "手续费及佣金净收入", "合并", "单体"]
try VNImageRequestHandler(url: url).perform([request])
struct TextBox {
    let x: CGFloat
    let y: CGFloat
    let height: CGFloat
    let text: String
}
let boxes = (request.results ?? []).compactMap { observation -> TextBox? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    return TextBox(x: observation.boundingBox.minX, y: observation.boundingBox.midY,
                   height: observation.boundingBox.height, text: candidate.string)
}.sorted { $0.y > $1.y }
var rows: [[TextBox]] = []
for box in boxes {
    if let last = rows.last, let first = last.first,
       abs(first.y - box.y) < min(first.height, box.height) * 0.55 {
        rows[rows.count - 1].append(box)
    } else { rows.append([box]) }
}
for row in rows {
    print(row.sorted { $0.x < $1.x }.map { $0.text }.joined(separator: "    |    "))
}
