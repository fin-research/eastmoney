// macOS: swift pdf-text.swift /absolute/file.pdf  —— 输出 PDF 全部文字（PDFKit）
import Foundation
import PDFKit
guard CommandLine.arguments.count > 1, let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else { exit(1) }
print(doc.string ?? "")
