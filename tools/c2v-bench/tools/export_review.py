#!/usr/bin/env python3
"""Build local review indexes from frozen run receipts; never infer quality verdicts."""
import argparse
import csv
import json
import os
import statistics
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bench'))
from core import Store, evaluation, now, atomic
from local_media import cached_original


def export(root, owner, cohorts, bench_url='http://127.0.0.1:18942'):
    store = Store(root / 'runtime/runs')
    runs = sorted([r for r in store.list(owner) if r['cohort'] in cohorts], key=lambda r:(r['case']['id'],r['model_requested']['model'] != 'deepseek-c2v-v1',r['created_at']))
    folder = root / 'runtime/review'; folder.mkdir(parents=True,exist_ok=True)
    rows=[]
    for r in runs:
        e=evaluation(r);p=r.get('probe') or {};m=(r.get('job') or {}).get('model_selection') or r['model_requested']
        dest=cached_original(root,r)
        row={'case_id':r['case']['id'],'title':r['case']['title'],'model':m['model'],'model_revision':m.get('revision'),'cohort':r['cohort'],'skill_policy':r['case']['skill_policy'],'run_id':r['id'],'job_id':r.get('job_id'),'session_id':r.get('session_id'),'state':r['state'],'downloaded':bool(dest),'local_path':str(dest) if dest else None,'relative_path':str(dest.relative_to(root)) if dest else None,'sha256':(r.get('local_original') or {}).get('sha256'),'bytes':(r.get('local_original') or {}).get('bytes'),'duration_seconds':p.get('duration_seconds'),'width':p.get('width'),'height':p.get('height'),**e,'review_url':bench_url+'/?tab=review&case='+r['case']['id']}
        rows.append(row)
        if dest:
            atomic(dest.with_suffix('.json'),{'exported_at':now(),'result':row,'case':r['case'],'input_assets':r.get('input_assets_snapshot'),'model_requested':r['model_requested'],'skill_requested':r['skill_requested'],'skill_actual':r['job'].get('experimental_skills'),'probe':p,'reviews':r.get('reviews',[])})
            md=['# '+r['case']['title'],'','- 模型：`'+m['model']+'`','- 批次：`'+r['cohort']+'`','- [本地原片]('+dest.name+')','- [网页对照与评价]('+row['review_url']+')','- 评价状态：'+e['quality']+'（完整解码与内容质量分别统计）','','## 原始需求','',r['case']['prompt_original'],'','## 实际提交 prompt','',r['case']['prompt_submitted'],'','## 验收要点','']
            md.extend('- '+x for x in r['case']['requirements']['quality_checks'])
            md.extend(['','## 参考与输入',''])
            assets={a['id']:a for a in json.loads((root/'dataset'/('v'+r['suite_version'])/'suite.json').read_text())['assets']}
            for aid in r['case']['input_assets']:
                a=assets[aid];md.append('- 输入：['+a['name']+'](<'+os.path.relpath(root/a['path'],dest.parent)+'>)')
            refs=r['case']['reference_outputs']
            if not refs:md.append('业务未提供参考成片。')
            for ref in refs:
                link=os.path.relpath(root/assets[ref['asset_id']]['path'],dest.parent) if ref.get('asset_id') else ref['url']
                md.append('- [业务参考成片](<'+link+'>)（模型未知，不是标准答案）：'+ref.get('inspection_note',''))
            (dest.parent/'任务说明.md').write_text('\n'.join(md)+'\n')
    atomic(folder/'results.json',{'at':now(),'owner':owner,'cohorts':cohorts,'rows':rows})
    if rows:
        with (folder/'results.csv').open('w',encoding='utf-8-sig',newline='') as f:
            w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows({k: ("\'" + v if isinstance(v,str) and v[:1] in "=+-@" else v) for k,v in row.items()} for row in rows)
    md=['# C2V 业务测试审核索引','','[打开测试台总览]('+bench_url+'/?tab=results) · [逐案审核]('+bench_url+'/?tab=review)','','范围：本轮 '+str(len({x['case_id'] for x in rows}))+' 案、'+str(len(rows))+' 条正式结果；已撤回的旧模型/失败渠道试投不计入。原片未转码，按模型／任务存放。网页默认 2 倍速，可切回 1 倍速检查。','','| 模型 | 成片 | 本地原片 | 解码通过 | 执行中位数 | 执行最长 | 人工评价 |','|---|---:|---:|---:|---:|---:|---:|']
    for model in sorted({x['model'] for x in rows},key=lambda x:(x!='deepseek-c2v-v1',x)):
        rr=[x for x in rows if x['model']==model];ts=[x['execution_seconds'] for x in rr if x['execution_seconds'] is not None]
        md.append('| %s | %s/%s | %s/%s | %s/%s | %.1f 分 | %.1f 分 | %s/%s |'%(model,sum(x['has_video'] for x in rr),len(rr),sum(x['downloaded'] for x in rr),len(rr),sum(x['render_verified'] is True for x in rr),len(rr),statistics.median(ts)/60,max(ts)/60,sum(x['quality']!='unreviewed' for x in rr),len(rr)))
    md+=['','执行＝started_at 到 finished_at，含模型、工具、自检、渲染，不含排队；不是纯推理时间。完整解码通过只证明文件可读取；内容、品牌文字、指令和视觉质量仍需人工审核。','','| 案例 | 自研 C2V 原片 / 执行耗时 | Opus 5.5 原片 / 执行耗时 |','|---|---|---|']
    for cid in sorted({x['case_id'] for x in rows}):
        rr=[x for x in rows if x['case_id']==cid];cells=[]
        for own in [True,False]:
            items=[x for x in rr if (x['model']=='deepseek-c2v-v1')==own]
            cells.append(' · '.join(('[原片]('+os.path.relpath(x['local_path'],folder)+')' if x['downloaded'] else '未下载')+' / %.1f 分'%(x['execution_seconds']/60) for x in items))
        md.append('| ['+rr[0]['title']+']('+rr[0]['review_url']+') | '+' | '.join(cells)+' |')
    md+=['','## 审核提醒','','- 原始需求、提交 prompt、参考图与未知模型参考片都可在逐案审核页展开。蛋白质案无参考视频；睡眠案保留对应参考。','- 按实际 prompt 验收；未指定时长的案例不以参考视频长度判失败。','- 两个 Anatomy 案仍单独留有 skill 统计。具体 skill 是否正确使用、三维要求是否满足，需要结合画面与轨迹判断。','- `results.csv` 为逐条统计；每条原片旁的 JSON 保留模型、任务与校验信息，`任务说明.md` 可脱离网页查阅。','- 测试台保存人工评价及时间点证据，不覆盖历次评价。重新运行导出工具可刷新本索引。','']
    (folder/'审核索引.md').write_text('\n'.join(md))
    return {'runs':len(rows),'downloaded':sum(x['downloaded'] for x in rows),'decoded':sum(x['render_verified'] is True for x in rows),'index':str(folder/'审核索引.md')}


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--data-root',type=Path,default=ROOT);p.add_argument('--owner',required=True);p.add_argument('--cohort',action='append',required=True);p.add_argument('--bench-url',default='http://127.0.0.1:18942');a=p.parse_args()
    print(json.dumps(export(a.data_root.resolve(),a.owner,a.cohort,a.bench_url),ensure_ascii=False))
