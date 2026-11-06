// macOS: swift ocr.swift /absolute/image.png > /absolute/ocr.txt
import AppKit
import Vision

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.usesLanguageCorrection = false
try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
for result in request.results ?? [] {
    if let candidate = result.topCandidates(1).first { print(candidate.string) }
}
