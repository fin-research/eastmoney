#!/usr/bin/env python3
"""Lossless Word/PDF archive import. Preview first; --apply --remote writes generated SQL to D1.

No model calls. Same-stem formats are one record; identity is SHA-256 of the preferred
source text. Changed source text becomes a new record, never overwrites an edited draft.
"""
import argparse
import hashlib
import json
import re
import subprocess
from datetime import date, datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
ROOT = Path(__file__).resolve().parents[1]


def paragraph(element):
    return ''.join(node.text or '' if node.tag == W + 't' else '\n' if node.tag in (W+'br', W+'cr') else '\t'
                   for node in element.iter() if node.tag in (W+'t', W+'br', W+'cr', W+'tab'))


def extract_docx(path):
    with ZipFile(path) as archive:
        body = ET.fromstring(archive.read('word/document.xml')).find(W+'body')
    blocks = []
    for node in body:
        if node.tag == W+'p':
            blocks.append(paragraph(node))
        elif node.tag == W+'tbl':
            rows = []
            for row in node.findall(W+'tr'):
                rows.append(['<br>'.join(paragraph(p) for p in cell.findall(W+'p')).replace('|', '\\|')
                             for cell in row.findall(W+'tc')])
            if rows:
                width = max(map(len, rows))
                for index, row in enumerate(rows):
                    blocks.append('| ' + ' | '.join(row + [''] * (width-len(row))) + ' |')
                    if index == 0:
                        blocks.append('| ' + ' | '.join(['---'] * width) + ' |')
    return '\n'.join(blocks).strip()


def extract_pdf(path):
    return subprocess.run(['pdftotext', '-layout', str(path), '-'], check=True,
                          capture_output=True, text=True).stdout.strip()


def chinese_date(value):
    match = re.search(r'(20\d{2})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})', value)
    return date(*map(int, match.groups())).isoformat() if match else ''


def structure(text, filename):
    labels = dict(re.findall(r'^([^\n：:]{2,12})[：:]\s*([^\n]+)', text, re.M))
    def field(*names):
        return next((labels[name].strip() for name in names if name in labels), '')
    sections = list(re.finditer(r'【([^】]+)】', text))
    summary, commentary, recommendation = [], [], []
    for index, heading in enumerate(sections):
        name = heading.group(1)
        if name == '东财证券':
            continue
        # Keep heading suffixes (e.g. comparison period) and all numbered subheadings.
        body = text[heading.end():sections[index+1].start() if index+1 < len(sections) else len(text)].strip()
        if name in ('事件摘要', '核心结论', '关键信息', '摘要'):
            body = re.sub(r'^（焦点）\s*', '', body)
            summary.append(body)
        elif '建议' in name:
            recommendation.append(body)
        else:
            commentary.append((f'【{name}】\n' if name not in ('时事快评','时事点评','政策跟踪') else '') + body)
    title = field('事件名称', '会议名称', '政策名称', '报告名称', '主题')
    if not title or not summary or not commentary:
        raise ValueError(f'{filename}: missing title, summary or commentary; refusing partial import')
    return {
        'eventName': title,
        'type': 'overseas_event' if filename.startswith('海外事件') else 'policy_tracking' if filename.startswith(('政策跟踪','会议跟踪','例会跟踪')) else 'current_affairs',
        'sources': field('消息来源', '资料来源', '信息来源', '来源'),
        'eventPublishedAt': chinese_date(field('发布时间', '发布日期')),
        'commentaryDate': chinese_date(field('快评时间', '点评时间', '评论时间', '汇总时间')),
        'eventSummary': '\n\n'.join(summary), 'commentary': '\n\n'.join(commentary),
        'recommendation': '\n\n'.join(recommendation),
    }


def scan(directory):
    grouped = {}
    for path in sorted(directory.rglob('*')):
        if path.is_file() and not path.name.startswith(('~$', '.')) and path.suffix.lower() in ('.docx','.pdf','.md'):
            grouped.setdefault(str(path.relative_to(directory).with_suffix('')), []).append(path)
    records = []
    for stem, files in grouped.items():
        source = next((p for p in files if p.suffix.lower() == '.docx'), None)
        source = source or next((p for p in files if p.suffix.lower() == '.pdf'), None)
        if source is None:
            continue
        text = extract_docx(source) if source.suffix.lower() == '.docx' else extract_pdf(source)
        content = structure(text, source.name)
        digest = hashlib.sha256(text.encode()).hexdigest()
        records.append({ 'id': 'archive-' + digest, 'importKey': digest, **content, 'originalText': text,
            'filename': source.name, 'sourceFiles': [{'name': str(p.relative_to(directory)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files],
            'missing': [field for field in ('sources','eventPublishedAt','commentaryDate','recommendation') if not content[field]] })
    return records


def literal(value):
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"


def import_sql(records, now):
    statements = []
    for record in records:
        columns = ['id','commentary_type','event_name','sources','event_published_at','commentary_date','event_summary','commentary','recommendation','edited','created_at','updated_at']
        values = [record[k] for k in ('id','type','eventName','sources','eventPublishedAt','commentaryDate','eventSummary','commentary','recommendation')] + [1,now,now]
        statements.append(f"INSERT INTO commentary ({','.join(columns)}) VALUES ({','.join(map(literal,values))}) ON CONFLICT(id) DO NOTHING;")
        data = [record['id'], 'import', record['originalText'], json.dumps(record['sourceFiles'],ensure_ascii=False), record['importKey']]
        statements.append(f"INSERT INTO commentary_workspace(commentary_id,origin,original_text,source_files_json,import_key) VALUES ({','.join(map(literal,data))}) ON CONFLICT(commentary_id) DO NOTHING;")
    return '\n'.join(statements) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='Private preview directory outside Git')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--remote', action='store_true')
    args = parser.parse_args()
    if args.apply and not args.remote:
        parser.error('--apply requires explicit --remote')
    output = args.output.expanduser().resolve()
    if output == ROOT or ROOT in output.parents:
        parser.error('Preview and source data must stay outside the repository')
    records = scan(args.input.expanduser().resolve())
    if not records:
        raise SystemExit('No documents found')
    output.mkdir(parents=True,exist_ok=True)
    manifest = output/'manifest.json'
    manifest.write_text(json.dumps(records,ensure_ascii=False,indent=2))
    sql = output/'import.sql'
    sql.write_text(import_sql(records, datetime.now(timezone.utc).isoformat()))
    print(json.dumps({'documents':len(records),'unique':len(set(r['id'] for r in records)),
        'missing':[{'filename':r['filename'],'fields':r['missing']} for r in records if r['missing']], 'manifest':str(manifest)},ensure_ascii=False))
    if args.apply:
        subprocess.run([str(ROOT/'node_modules/.bin/wrangler'),'d1','execute','DB','--remote','--file',str(sql)],cwd=ROOT,check=True)


if __name__ == '__main__':
    main()
