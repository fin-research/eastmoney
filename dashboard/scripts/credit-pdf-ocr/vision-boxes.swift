import Foundation
import Vision
import ImageIO

guard CommandLine.arguments.count == 2 else { fatalError("Usage: vision-boxes image.png") }
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = true
request.minimumTextHeight = 0.003
try VNImageRequestHandler(url: url).perform([request])
let boxes: [[String: Any]] = (request.results ?? []).compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let rect = observation.boundingBox
    return ["text": candidate.string, "confidence": candidate.confidence,
            "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}.sorted {
    let ay = $0["y"] as! CGFloat, by = $1["y"] as! CGFloat
    if abs(ay - by) > 0.004 { return ay > by }
    return ($0["x"] as! CGFloat) < ($1["x"] as! CGFloat)
}
let data = try JSONSerialization.data(withJSONObject: boxes, options: [.fragmentsAllowed])
print(String(data: data, encoding: .utf8)!)
