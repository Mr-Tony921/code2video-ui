"""Compact conversational intake; exact line spans retain business text without regeneration."""
import hashlib,json,math,re
MARKER=re.compile(r'(?:分镜\s*\d+|【?镜头\s*\d+(?:】|(?=[（(:：\s]|$)))')
INSTRUCTIONS='''You are conversational intake for a whitebox story, not the scene author. The user does not need JSON or technical specifications. Return ONLY a small JSON decision.
If the story/duration is missing or contradictory ask one concise question: {"action":"clarify","text":"..."}. Do not ask about technical formats or facts already supplied. Never claim image inspection: you receive attachment labels only; the author receives all images later.
For a detailed storyboard use {"action":"generate","segments":[{"title":"user's title","first_line":1,"last_line":40,"duration":15}]}.
Line numbers refer to SOURCE_LINES, inclusive, 1-based. Select every segment in original order, including its title, duration, shot content, dialogue and camera requirements. Segment spans must be non-overlapping. Do not copy or paraphrase any shot text in your response: the host copies these exact lines. Original shot numbering stays intact. Include all explicit business shots; do not turn an individual shot into a segment. Use explicit segment durations; allocate only unspecified durations within a stated overall total. Do not invent new story beats. Preserve an explicitly supplied segment id in an optional "id" field. Text outside these spans is retained as global original instructions by the host.
If the user supplies a wish/story without shot markers, use {"action":"generate","planned_segments":[{"title":"...","duration":20,"prompt":"分镜1 ...\n分镜2 ..."}]}. Create the smallest necessary faithful storyboard. Preserve the original natural-language requirements, do not add elaborate action, decoration or camera movement. The host keeps the user's raw text as global requirements. Never put a formatted storyboard in a clarification question.
If the input already contains shot markers, use exact spans only; never regenerate or summarize those shots. All explicit times must agree. Story duration is >0 and <=300 seconds. If constraints contradict, clarify instead of silently shortening. No extra planning/tool calls, no source code, no discussion or reasoning in the response. This is routing and segmentation, not visual composition or source authoring.'''

# Explicit section headers establish ownership of all following shot lines.
# Models identify semantic spans, but cannot move a shot suffix into global text.
SECTION_HEADER=re.compile(r'^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:【)?(?:片段|段落|Beat|Segment)\s*(?:\d+|[一二三四五六七八九十百]+)(?:】)?(?=$|[\s：:（(|｜.\-—*])',re.I)
GLOBAL_HEADER=re.compile(r'^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:【)?(?:全局(?:要求|说明|约束)|整体(?:要求|说明|约束)|Global\s+(?:requirements|notes|constraints))(?:】)?(?=$|[\s：:])',re.I)

def complete_explicit_blocks(spans,lines):
    headers=[i+1 for i,line in enumerate(lines) if SECTION_HEADER.match(line)]
    if len(headers)!=len(spans):return spans,[]
    corrected=[];changes=[]
    for i,(h,s) in enumerate(zip(headers,spans)):
        end=headers[i+1]-1 if i+1<len(headers) else len(lines)
        globals=[n+1 for n in range(h,end) if GLOBAL_HEADER.match(lines[n])]
        if globals:end=globals[0]-1
        # Trim only empty separators. Exact nonblank lines remain in this block.
        while end>=h and not lines[end-1].strip():end-=1
        first,last=s.get('first_line'),s.get('last_line')
        if type(first)!=int or type(last)!=int or not h<=first<=last<=end:return spans,[]
        # The model's segment must refer to this block's first actual shot;
        # otherwise this is a semantic split/merge, not a harmless endpoint miss.
        markers=[n+1 for n in range(h-1,end) if MARKER.search(lines[n])]
        if not markers or not first<=markers[0]<=last:return spans,[]
        fixed={**s,'first_line':h,'last_line':end};corrected.append(fixed)
        if first!=h or last!=end:changes.append({'segment_index':i,'original':[first,last],'effective':[h,end],'reason':'explicit source section owns complete shot text through next section/global heading'})
    return corrected,changes

def source_text(turns):
    # User words are kept once. Conversation history remains separately archived.
    return '\n\n'.join(t['user'] for t in turns if t.get('user'))

def prompt_for(source,turns,images):
    return INSTRUCTIONS+'\nPREVIOUS_CLARIFICATIONS:'+json.dumps([{'user':t.get('user'), 'assistant':t.get('assistant')} for t in turns[:-1]],ensure_ascii=False)+'\nREFERENCE_ATTACHMENTS:'+json.dumps([{'id':f'reference_{i+1}','filename':label} for i,(label,_) in enumerate(images)],ensure_ascii=False)+'\nSOURCE_LINES:\n'+'\n'.join(f'{i:04d}: {line}' for i,line in enumerate(source.splitlines(),1))

def assemble(decision,source):
    if decision.get('action')!='generate':return decision,None
    lines=source.splitlines();spans=decision.get('segments');planned=decision.get('planned_segments')
    if bool(spans)==bool(planned):raise ValueError('Intake requires either exact segment spans or a planned prose storyboard')
    boundary_corrections=[]
    if spans:spans,boundary_corrections=complete_explicit_blocks(spans,lines)
    used=set();out=[];cursor=0.;previous_end=0;ids=set();maps=[]
    if planned and MARKER.search(source):raise ValueError('Detailed user shots must be copied from original spans, not rewritten')
    for i,s in enumerate(spans or planned,1):
        duration=s.get('duration')
        if isinstance(duration,bool) or not isinstance(duration,(int,float)) or not math.isfinite(duration) or duration<=0:raise ValueError('Invalid segment duration from intake')
        sid=s.get('id') or f'seg_{i:03d}'
        if not isinstance(sid,str) or not sid or sid in ids:raise ValueError('Invalid or duplicate segment id')
        ids.add(sid)
        if spans:
            first,last=s.get('first_line'),s.get('last_line')
            if type(first)!=int or type(last)!=int or not 1<=first<=last<=len(lines) or first<=previous_end:raise ValueError('Invalid, reordered or overlapping source spans')
            text='\n'.join(lines[first-1:last]);previous_end=last;used.update(range(first-1,last))
            if not MARKER.search(text):raise ValueError('Detailed source segment has no shot markers')
            maps.append({'segment_id':sid,'first_line':first,'last_line':last,'verbatim_sha256':hashlib.sha256(text.encode()).hexdigest()})
        else:
            text=s.get('prompt','')
            if not isinstance(text,str) or not MARKER.search(text):raise ValueError('Prose plan requires explicit internal shot markers')
        out.append({'id':sid,'title':s.get('title') or f'片段{i}','duration':duration,'resolved_duration':duration,'start':cursor,'end':cursor+duration,'prompt':text});cursor+=duration
    if cursor>300:raise ValueError('Intake cannot silently shorten or exceed the 300-second story limit')
    unassigned='\n'.join(line for i,line in enumerate(lines) if i not in used)
    if spans and MARKER.search(unassigned):raise ValueError('Intake omitted one or more original shots')
    # Exactly once in the engine task: body -> segment prompts, outside text -> work_prompt.
    initial={'version':2,'duration':cursor,'work_prompt':unassigned if spans else source,'segments':out}
    audit={'policy':'verbatim-block-boundaries-v2' if spans else 'prose-plan-with-original-v1','source_sha256':hashlib.sha256(source.encode()).hexdigest(),'source_lines':len(lines),'segment_spans':maps,'boundary_corrections':boundary_corrections,'original_lines_retained':len(lines),'source_text_rewritten':False,'model_calls':1,'repair_budget_used':0}
    return {'action':'generate','input':initial},audit

NUMBER=r'(\d+(?:\.\d+)?)'
UNIT=r'(秒|s|分钟|min(?:utes?)?)'
DURATION=re.compile(r'^\s*(?:片段\s*)?(?:时长|duration)\s*[:：]\s*'+NUMBER+r'\s*'+UNIT+r'\s*[。.]?\s*$',re.I)
INTERVAL=re.compile(NUMBER+r'\s*(?:秒|s)\s*[-–—~至]\s*'+NUMBER+r'\s*(?:秒|s)',re.I)
TOTAL=re.compile(r'(?:总时长|总共|总计|总长|全片|整体|共|total(?:\s+duration)?)\s*[:：]?\s*'+NUMBER+r'\s*'+UNIT,re.I)

def seconds(value,unit):
    return float(value)*(60 if unit.lower().startswith('min') or unit=='分钟' else 1)

def explicit_story_decision(source):
    """No semantic planning: only fully timed, explicitly delimited source blocks.
    Ambiguous/missing/contradictory instructions retain conversational intake.
    """
    lines=source.splitlines();headers=[n for n,line in enumerate(lines) if SECTION_HEADER.match(line)]
    if not headers:return None
    spans=[];cursor=0.
    for i,start in enumerate(headers):
        end=headers[i+1] if i+1<len(headers) else len(lines)
        global_starts=[n for n in range(start+1,end) if GLOBAL_HEADER.match(lines[n])]
        if global_starts:end=global_starts[0]
        while end>start and not lines[end-1].strip():end-=1
        shot_lines=[n for n in range(start,end) if MARKER.search(lines[n])]
        if not shot_lines:return None
        preamble=lines[start:shot_lines[0]];durations=[];ranges=[]
        for line in preamble:
            m=DURATION.match(line)
            if m:durations.append(seconds(m[1],m[2]))
        # An explicit time interval belongs on the section heading, not dialogue.
        for m in INTERVAL.finditer(lines[start]):ranges.append((float(m[1]),float(m[2])))
        if len(ranges)>1:return None
        if ranges:
            a,b=ranges[0]
            if abs(a-cursor)>.001 or b<=a:return None
            durations.append(b-a)
        if not durations or any(not math.isfinite(d) or d<=0 or abs(d-durations[0])>.001 for d in durations):return None
        duration=durations[0]
        # Clear per-shot timing contradictions must still reach clarification.
        known=[]
        for j,shot in enumerate(shot_lines):
            stop=shot_lines[j+1] if j+1<len(shot_lines) else end
            values=[seconds(m[1],m[2]) for line in lines[shot+1:stop] if (m:=DURATION.match(line))]
            if len(values)>1:return None
            if values and values[0]<=0:return None
            known.extend(values)
        if sum(known)>duration+.001 or (len(known)==len(shot_lines) and abs(sum(known)-duration)>.001):return None
        spans.append({'title':lines[start].strip(),'first_line':start+1,'last_line':end,'duration':duration});cursor+=duration
    if not 0<cursor<=300:return None
    decision={'action':'generate','segments':spans}
    try:result,_=assemble(decision,source)
    except ValueError:return None
    global_text=result['input']['work_prompt']
    # Questions, alternate timing instructions and analysis-only requests retain
    # model routing. A complete storyboard is not implicit consent to ignore them.
    if re.search(r'不要生成|不(?:要|必)制作|(?:仅|只)(?:做|需|要)?(?:分析|讨论|解释)|先(?:分析|讨论|确认)|[?？]',global_text):return None
    totals=list(TOTAL.finditer(global_text))
    if any(abs(seconds(m[1],m[2])-cursor)>.001 for m in totals):return None
    for timing in re.finditer(NUMBER+r'\s*'+UNIT,global_text,re.I):
        if not any(t.start()<=timing.start()<t.end() for t in totals):return None
    return decision

def decide(provider,parse_json,turns,images,write,work):
    source=source_text(turns);old_context=provider.context
    explicit=explicit_story_decision(source) if len(turns)==1 else None
    if explicit is not None:
        result,audit=assemble(explicit,source)
        audit.update(policy='explicit-source-blocks-v3',model_calls=0,routing='deterministic complete source sections; no image interpretation or scene planning')
        write(work/'intake-decision.json',{'routing':'deterministic',**explicit});write(work/'intake-input-map.json',audit)
        return result

    # Input text is in SOURCE_LINES, not duplicated in SAVED_CONVERSATION.
    provider.context=''
    try:response=provider.call(prompt_for(source,turns,images),[],effort='low',json_mode=True)
    finally:provider.context=old_context
    raw=parse_json(response['text']);write(work/'intake-decision.json',raw)
    result,audit=assemble(raw,source)
    if audit:write(work/'intake-input-map.json',audit)
    return result
