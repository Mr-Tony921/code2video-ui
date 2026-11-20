import hashlib,json,os,sys,unittest
from pathlib import Path
R=Path(os.environ.get('SEKO_TEST_ROOT','/mnt/afs_if/codevideo/workspace/code2video-dev-codex'))
E=R/'assets/whitebox-seko/releases'/os.environ.get('SEKO_TEST_RELEASE','seko-0.1.10-cvw.1')/'engine'
sys.path.insert(0,str(E/'python'))
from seko_engine.line_patches import apply_line_patch,numbered_source,source_sha256
from seko_engine.provider import apply_source_patch

class LinePatches(unittest.TestCase):
    SOURCE='export async function buildScene() {\n  const x = "矿坑";\n  return {x};\n}\n'
    def patch(self,edits,source=None,**extras):
        source=self.SOURCE if source is None else source
        return {'source_sha256':source_sha256(source),'line_edits':edits,**extras}
    def edit(self,start,end,new):return {'start_line':start,'end_line':end,'new_lines':new}
    def test_numbered_full_source_and_exact_hash(self):
        text=numbered_source(self.SOURCE)
        self.assertIn(hashlib.sha256(self.SOURCE.encode()).hexdigest(),text)
        self.assertIn('L2:   const x = "矿坑";\n',text)
        self.assertEqual(''.join(line.split(': ',1)[1] for line in text.splitlines(True)[2:]),self.SOURCE)
    def test_disjoint_edits_use_original_line_addresses(self):
        patch=self.patch([self.edit(3,3,['  return {x, y};']),self.edit(2,2,['  const x = "矿坑";','  const y = 1;'])])
        actual=apply_source_patch(self.SOURCE,json.dumps(patch))
        self.assertEqual(actual,'export async function buildScene() {\n  const x = "矿坑";\n  const y = 1;\n  return {x, y};\n}\n')
    def test_delete_and_preserve_eof_crlf_unicode_separators(self):
        source='a\r\nb\r\nc';self.assertEqual(apply_line_patch(source,self.patch([self.edit(2,2,[])],source)),'a\r\nc')
        self.assertEqual(apply_line_patch(source,self.patch([self.edit(2,2,['b1','b2'])],source)),'a\r\nb1\r\nb2\r\nc')
        source='const a="x\u2028y";\nlast\n'
        self.assertEqual(apply_line_patch(source,self.patch([self.edit(2,2,['final'])],source)),'const a="x\u2028y";\nfinal\n')
    def test_invalid_batch_never_partially_applies(self):
        first=self.edit(2,2,['  const x="valid edit";'])
        for bad in [self.edit(2,3,[]),self.edit(3,10,[]),self.edit(True,1,[]),self.edit(3,3,['two\nlines']),self.edit(3,3,[12]),{'start_line':3,'end_line':3,'new_lines':[],'guess':True}]:
            with self.subTest(bad=bad),self.assertRaises(ValueError):apply_source_patch(self.SOURCE,json.dumps(self.patch([first,bad])))
        with self.assertRaisesRegex(ValueError,'stale_source'):apply_line_patch(self.SOURCE,self.patch([first])|{'source_sha256':'stale'})
        with self.assertRaises(ValueError):apply_line_patch(self.SOURCE,self.patch([first],unexpected=1))
    def test_existing_substring_protocol_retained_without_fuzzy_match(self):
        result=apply_source_patch(self.SOURCE,json.dumps({'replacements':[{'old':'return {x};','new':'return {x, y:1};'}]}))
        self.assertIn('return {x, y:1};',result)
        with self.assertRaisesRegex(ValueError,'patch_match'):apply_source_patch(self.SOURCE,json.dumps({'replacements':[{'old':'return {wrong};','new':'return {};'}]}))

if __name__=='__main__':unittest.main()
