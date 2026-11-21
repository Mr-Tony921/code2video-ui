from pathlib import Path
import importlib.util, json, unittest
ROOT = Path(__file__).resolve().parents[2]
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result
engine = module('frozen_intake', ROOT/'assets/whitebox-seko/releases/seko-0.1.12-cvw.1/engine/python/seko_engine/intake.py')
web = module('web_intake', ROOT/'apps/worker-bridge/scripts/seko-intake.py')
class Provider:
    context = 'existing context'
    def __init__(self, reply): self.reply = reply; self.calls = []
    def call(self, prompt, images, **kw):
        self.calls.append((prompt, images, kw, self.context))
        return {'text': json.dumps(self.reply, ensure_ascii=False)}
class Intake(unittest.TestCase):
    def decide(self, source, reply, images=None):
        provider = Provider(reply); written = {}
        result = web.decide(provider, json.loads, [{'user':source}], images or [],
                            lambda p,v: written.__setitem__(p.name,v), Path('/unused'), engine)
        self.assertEqual(provider.context, 'existing context')
        return result, provider, written
    def test_omitted_duration_one_call_original_text_and_references_retained(self):
        source = '两人在雨天相遇，握手后分别离开。'
        result, provider, written = self.decide(source, {'action':'generate','planned_segments':[
            {'title':'相遇','duration':18,'prompt':'分镜1 两人相遇并握手。\n分镜2 分别离开。'}]}, [('reference-001.jpg', object())])
        self.assertEqual(result['input']['duration'],18)
        self.assertEqual(result['input']['work_prompt'],source)
        self.assertEqual(len(provider.calls),1)
        prompt, images, kw, context = provider.calls[0]
        self.assertIn('An omitted duration alone is never a reason to clarify',prompt)
        self.assertIn('Preserve every explicit segment/shot/overall duration',prompt)
        self.assertIn('reference-001.jpg',prompt)
        self.assertTrue(prompt.endswith('0001: '+source)); self.assertEqual(images,[])
        self.assertEqual(kw,{'effort':'low','json_mode':True}); self.assertEqual(context,'')
        self.assertFalse(written['intake-policy.json']['original_user_text_modified'])
        self.assertEqual(written['intake-input-map.json']['repair_budget_used'],0)
    def test_english_generated_markers_are_canonical_but_source_and_reply_unchanged(self):
        source='A person leaves a bag, then greets a friend.'
        raw={'action':'generate','planned_segments':[{'duration':12,'prompt':'Shot 1: Leave the bag.\nShot 2: Greet the friend.'}]}
        result,p,w=self.decide(source, raw)
        self.assertEqual(result['input']['work_prompt'],source)
        self.assertEqual(result['input']['segments'][0]['prompt'],'分镜1 Leave the bag.\n分镜2 Greet the friend.')
        self.assertEqual(w['intake-decision.json'],raw)
        self.assertTrue(raw['planned_segments'][0]['prompt'].startswith('Shot 1:'))
        self.assertEqual(w['intake-policy.json']['generated_shot_marker_changes'][0]['markers'],2)
        self.assertEqual(len(p.calls),1)
    def test_generated_english_dash_markers_preserve_words_and_raw_decision(self):
        for dash in ['—','–','-']:
            raw={'action':'generate','planned_segments':[{'duration':10,'prompt':'Shot 1 '+dash+' Put the bowl down.\nShot 2 '+dash+' Sit together.'}]}
            result,p,w=self.decide('Keep the bowl upright, then sit.',raw)
            self.assertIn('分镜1 Put the bowl down.',result['input']['segments'][0]['prompt'])
            self.assertEqual(w['intake-decision.json'],raw)
            self.assertEqual(len(p.calls),1)

    def test_marker_normalization_does_not_rewrite_source_spans_or_story_words(self):
        raw={'action':'generate','segments':[{'first_line':1,'last_line':2,'duration':12,'title':'Shot 1: A'}]}
        self.assertEqual(web.canonical_plan_markers(raw),(raw,[]))
        raw={'action':'generate','planned_segments':[{'duration':12,'prompt':'分镜1 A says Shot 1: is ready.'}]}
        self.assertEqual(web.canonical_plan_markers(raw),(raw,[]))
    def test_explicit_timed_blocks_keep_zero_call_route(self):
        source='总时长10秒\n片段1：见面\n时长：6秒\n分镜1 两人握手\n片段2：离开\n时长：4秒\n分镜1 两人离开'
        result,p,w=self.decide(source, {})
        self.assertEqual(result['input']['duration'],10); self.assertEqual(p.calls,[])
        self.assertEqual([s['duration'] for s in result['input']['segments']],[6,4])
        self.assertEqual(w['intake-input-map.json']['model_calls'],0)
    def test_shots_without_timing_keep_exact_source_spans(self):
        source='片段1：见面\n分镜1 两人握手\n台词：好久不见'
        result,p,w=self.decide(source, {'action':'generate','segments':[{'first_line':1,'last_line':3,'duration':12}]})
        self.assertEqual(result['input']['segments'][0]['prompt'],source)
        self.assertEqual(result['input']['duration'],12)
    def test_contradictions_and_missing_story_can_still_clarify(self):
        for source in ('总时长10秒，片段1必须20秒。分镜1 握手', '帮我拍点东西'):
            result,p,w=self.decide(source, {'action':'clarify','text':'请补充故事或确认冲突的时间。'})
            self.assertEqual(result['action'],'clarify'); self.assertEqual(len(p.calls),1)
    def test_model_cannot_exceed_story_limit(self):
        with self.assertRaisesRegex(ValueError,'300-second'):
            self.decide('两人相遇',{'action':'generate','planned_segments':[{'duration':301,'prompt':'分镜1 两人相遇'}]})
    def test_context_restored_on_provider_error(self):
        class Broken(Provider):
            def call(self,*a,**kw): raise RuntimeError('provider unavailable')
        p=Broken({})
        with self.assertRaisesRegex(RuntimeError,'provider unavailable'):
            web.decide(p,json.loads,[{'user':'两人相遇'}],[],lambda *a:None,Path('/unused'),engine)
        self.assertEqual(p.context,'existing context')
    def test_policy_fails_closed_if_frozen_contract_changes(self):
        class Changed: INSTRUCTIONS='new contract'
        with self.assertRaisesRegex(ValueError,'contract changed'): web.instructions(Changed)
if __name__=='__main__': unittest.main()
