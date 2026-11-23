#!/usr/bin/env python3
import os,json,subprocess,time
from pathlib import Path
R=Path(__file__).resolve().parents[1];D=R/'runtime/validation'/('seko-check-'+str(time.time_ns()));D.mkdir(parents=True);(D/'tmp').mkdir(exist_ok=True)
env={**os.environ,'TMPDIR':str(D/'tmp'),'PYTHONDONTWRITEBYTECODE':'1','SEKO_TEST_RELEASE':os.environ.get('SEKO_TEST_RELEASE','seko-0.1.12-cvw.1'),'SEKO_TEST_FAST_INTAKE':'1'}
import sys
py=sys.executable
names=['seko-web-intake','seko-business-input','whitebox-batch','seko-audit','seko-responses','seko-memory','whitebox-prose-markers','whitebox-media','whitebox-transport','whitebox-flow','whitebox-input-boundaries','whitebox-intake-fast','whitebox-line-patches','whitebox-review-contract','whitebox-coarse-review','whitebox-curve-scope','whitebox-source-recovery','whitebox-hidden-scope','whitebox-visibility-scope']
commands=[[py,'tests/unit/'+n+'.py'] for n in names]
commands+=[[py,'tests/integration/'+n+'.py'] for n in ['whitebox-provider-failures','whitebox-review-boundary','whitebox-review-carryover','whitebox-camera-stage','whitebox-evidence-uncertainty']]
commands+=[['node','--test','tests/unit/seko-model.mjs','tests/unit/job-card-null-failure.mjs','tests/unit/whitebox-http.mjs','tests/unit/whitebox-geometry.mjs','tests/unit/whitebox-motion.mjs','tests/unit/whitebox-subjects.mjs','tests/unit/whitebox-camera-proposals.mjs','tests/unit/whitebox-focus.mjs','tests/unit/whitebox-focus-scope.mjs']]
engine=R/'assets/whitebox-seko/releases'/env['SEKO_TEST_RELEASE']/'engine'
if (engine/'tests/rigid-limbs.test.mjs').exists():
 commands+=[['node','--test',str(engine/'tests/runtime.test.mjs'),str(engine/'tests/rigid-limbs.test.mjs'),'tests/unit/whitebox-syntax-preflight.mjs']]
if (engine/'tests/motion-human.test.mjs').exists():
 commands+=[['node','--test',str(engine/'tests/motion-human.test.mjs')],[py,str(engine/'tests/test_repair_policy.py')]]
commands+=[['node','--test','tests/integration/seko-runner.mjs']]
rows=[]
for i,cmd in enumerate(commands):
 start=time.monotonic();log=D/('check-%02d.log'%i)
 with log.open('w') as f:r=subprocess.run(cmd,cwd=R,env=env,stdout=f,stderr=subprocess.STDOUT)
 rows.append({'command':cmd,'exit_code':r.returncode,'seconds':time.monotonic()-start,'log':str(log.relative_to(R))})
 (D/'checks.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows[-1]),flush=True)
raise SystemExit(1 if any(r['exit_code'] for r in rows) else 0)
