"""Atomic edits against a numbered, fingerprinted current module; never fuzzy match."""
import hashlib


def source_lines(source):
    # Split only JS source LF boundaries, not Unicode separators inside strings.
    parts = source.split('\n')
    return [part + '\n' for part in parts[:-1]] + ([parts[-1]] if parts[-1] else [])


def source_sha256(source):
    return hashlib.sha256(source.encode('utf-8')).hexdigest()


def numbered_source(source):
    lines = source_lines(source)
    return ('CURRENT_SOURCE_SHA256: ' + source_sha256(source) + '\n'
            + 'CURRENT_SOURCE (1-based line labels are metadata, not JavaScript):\n'
            + ''.join(f'L{i}: ' + line + ('' if line.endswith('\n') else '\n')
                      for i, line in enumerate(lines, 1)))


PATCH_PROTOCOL = '''Return ONLY JSON {"source_sha256":"the CURRENT_SOURCE_SHA256 above","line_edits":[{"start_line":1,"end_line":1,"new_lines":["replacement JavaScript line"]}]}. Use the actual 1-based source line labels, not shot IDs. Ranges are inclusive and refer to the ORIGINAL CURRENT_SOURCE, never renumber after an earlier edit. Each range replaces those complete lines; new_lines contains strings without line-break characters or L-number labels. Copy any unchanged text within the range exactly. Use [] to delete lines; to insert, replace one adjacent line with that unchanged line plus the inserted lines. Ranges must not overlap. Preserve all unaffected code. Do not resend old substrings or reconstruct line numbers from memory. Include the exact source SHA once. No markdown. Only if the module is structurally unusable may you return {"source":"complete corrected JS module"}.'''


def apply_line_patch(source, patch):
    if not isinstance(patch, dict) or set(patch) != {'source_sha256', 'line_edits'}:
        raise ValueError('line_patch_schema: expected source_sha256 and line_edits only; entire patch rolled back')
    if patch['source_sha256'] != source_sha256(source):
        raise ValueError('line_patch_stale_source: source SHA does not match CURRENT_SOURCE; entire patch rolled back')
    edits = patch['line_edits']
    if not isinstance(edits, list) or not edits or len(edits) > 10000:
        raise ValueError('line_patch_schema: expected nonempty bounded line_edits array')
    lines = source_lines(source)
    checked = []
    for index, edit in enumerate(edits):
        if not isinstance(edit, dict) or set(edit) != {'start_line', 'end_line', 'new_lines'}:
            raise ValueError(f'line_patch_schema at edit {index}: expected start_line,end_line,new_lines')
        start, end, new = edit['start_line'], edit['end_line'], edit['new_lines']
        if type(start) is not int or type(end) is not int or not 1 <= start <= end <= len(lines):
            raise ValueError(f'line_patch_range at edit {index}: lines must be within 1..{len(lines)}; entire patch rolled back')
        if not isinstance(new, list) or any(not isinstance(s, str) or '\n' in s or '\r' in s for s in new):
            raise ValueError(f'line_patch_schema at edit {index}: new_lines must contain strings without line breaks')
        checked.append((start, end, new))
    checked.sort(key=lambda item: item[0])
    if any(a[1] >= b[0] for a, b in zip(checked, checked[1:])):
        raise ValueError('line_patch_overlap: all ranges address original source and must be disjoint; entire patch rolled back')
    result = []; cursor = 0
    for start, end, new in checked:
        result.extend(lines[cursor:start-1])
        final = lines[end-1]
        eol = '\r\n' if final.endswith('\r\n') else '\n'
        if new:
            result.append(eol.join(new) + (eol if final.endswith('\n') else ''))
        cursor = end
    result.extend(lines[cursor:])
    output = ''.join(result)
    if len(output.encode('utf-8')) > 4_000_000:
        raise ValueError('line_patch_size: output exceeds source size bound')
    return output
