from pathlib import Path
import shutil,subprocess,tempfile
root=Path.cwd()
with tempfile.TemporaryDirectory(prefix='alia-concurrency-') as tmp:
 p=Path(tmp);shutil.copytree(root/'.github/workflows',p/'.github/workflows')
 script=root/'.github/scripts/check-workflow-concurrency.mjs'
 def run(ok):
  r=subprocess.run(['node',str(script)],cwd=p,capture_output=True,text=True)
  assert (r.returncode==0)==ok,r.stdout+r.stderr
  return r.stdout+r.stderr
 print(run(True).strip())
 publisher=p/'.github/workflows/publish-reviewed-images.yml';original=publisher.read_text()
 publisher.write_text(original.replace('cancel-in-progress: false','cancel-in-progress: true'))
 assert 'expected `false`' in run(False);print('cancellation mutation denied')
 publisher.write_text(original.replace('reviewed-image-publication-${{ github.repository }}','publication-${{ github.sha }}'))
 assert 'group varies per run' in run(False);print('per-SHA group mutation denied')
 publisher.write_text(original)
 (p/'.github/workflows/unreviewed.yml').write_text('name: extra\nconcurrency:\n  group: x\n  cancel-in-progress: false\n')
 assert 'set of workflows with a concurrency block changed' in run(False);print('unreviewed workflow mutation denied')
print('4 controls PASS; temporary copies cleaned')
