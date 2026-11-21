"""Web intake policy: an omitted duration is a planning choice, not missing story input.

Reuses the frozen engine's verbatim assembly and validation. No dataset estimates,
user-text additions, or extra model/repair calls are introduced.
"""

import copy
import re

POLICY = 'web-unspecified-duration-plan-v3'
GENERATED_SHOT = re.compile(r'(?im)^([ \t]*)Shot[ \t]*(\d+)[ \t]*[:：.)\-–—][ \t]*')

def canonical_plan_markers(raw):
    """Only generated prose plans: retain original source and raw model decisions."""
    effective = copy.deepcopy(raw)
    changes = []
    for index, segment in enumerate(effective.get('planned_segments') or []):
        prompt = segment.get('prompt')
        if not isinstance(prompt, str):
            continue
        normalized, count = GENERATED_SHOT.subn(lambda m: m[1] + '分镜' + m[2] + ' ', prompt)
        if count:
            segment['prompt'] = normalized
            changes.append({'segment_index': index, 'markers': count, 'from': 'Shot N', 'to': '分镜N'})
    return effective, changes


def instructions(engine_intake):
    original = engine_intake.INSTRUCTIONS
    old_question = 'If the story/duration is missing or contradictory ask one concise question:'
    old_timing = 'Use explicit segment durations; allocate only unspecified durations within a stated overall total.'
    if original.count(old_question) != 1 or original.count(old_timing) != 1:
        raise ValueError('Frozen intake instruction contract changed; review the web policy adapter')
    return original.replace(old_question,
        'If the story itself is missing or explicit constraints contradict, ask one concise question:').replace(old_timing,
        'Preserve every explicit segment/shot/overall duration. If only an overall total is stated, allocate unspecified durations within that total. '
        'If the user omitted durations, choose a concise, reasonable timing from the story complexity, with total duration >0 and <=300 seconds. '
        'An omitted duration alone is never a reason to clarify. Do not claim your chosen timing was requested by the user, '
        'and do not expand a short story to 300 seconds. Do not use dataset estimates or add timing instructions to the original user text.')


def decide(provider, parse_json, turns, images, write, work, engine_intake):
    source = engine_intake.source_text(turns)
    if len(turns) == 1 and engine_intake.explicit_story_decision(source) is not None:
        return engine_intake.decide(provider, parse_json, turns, images, write, work)
    prompt = engine_intake.prompt_for(source, turns, images)
    assert prompt.startswith(engine_intake.INSTRUCTIONS)
    prompt = instructions(engine_intake) + prompt[len(engine_intake.INSTRUCTIONS):]
    previous = provider.context
    provider.context = ''
    try:
        reply = provider.call(prompt, [], effort='low', json_mode=True)
    finally:
        provider.context = previous
    raw = parse_json(reply['text'])
    write(work / 'intake-decision.json', raw)
    effective, marker_changes = canonical_plan_markers(raw)
    if marker_changes:
        write(work / 'intake-effective-decision.json', effective)
    result, audit = engine_intake.assemble(effective, source)
    write(work / 'intake-policy.json', {'policy': POLICY, 'original_user_text_modified': False,
                                      'explicit_timing_authoritative': True, 'extra_model_calls': 0,
                                      'generated_shot_marker_changes': marker_changes})
    if audit:
        write(work / 'intake-input-map.json', {**audit, 'web_policy': POLICY})
    return result
