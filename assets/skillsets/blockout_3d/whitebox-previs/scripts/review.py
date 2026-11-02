"""Extract timestamped native-frame evidence or verify a silent previs MP4."""
import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import sys


def run(argv):
    result = subprocess.run(argv, capture_output=True, text=True)
    if result.returncode:
        raise ValueError(f'{argv[0]} failed: {result.stderr[-1500:]}')
    return result


def probe(video):
    data = json.loads(run(['ffprobe','-v','error','-count_frames','-show_streams','-show_format','-of','json',str(video)]).stdout)
    videos = [s for s in data['streams'] if s['codec_type'] == 'video']
    if len(videos) != 1:
        raise ValueError('Exactly one video stream is required')
    stream = videos[0]
    num, den = map(int,stream['avg_frame_rate'].split('/'))
    return data, stream, num/den, int(stream.get('nb_read_frames') or 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command',required=True)
    for name in ('sheet','strip'):
        sub = commands.add_parser(name)
        sub.add_argument('video',type=Path)
        sub.add_argument('output',type=Path)
        sub.add_argument('--step',type=float,default=1 if name == 'sheet' else .1)
        sub.add_argument('--columns',type=int,default=4)
        sub.add_argument('--width',type=int,default=320)
        sub.add_argument('--report',type=Path)
        if name == 'strip':
            sub.add_argument('--start',type=float,required=True)
            sub.add_argument('--end',type=float,required=True)
    sub = commands.add_parser('verify')
    sub.add_argument('video',type=Path)
    for name,kind in (('width',int),('height',int),('fps',float),('duration',float)):
        sub.add_argument('--'+name,type=kind,required=True)
    sub.add_argument('--audio',choices=('forbid','require','any'),default='forbid')
    sub.add_argument('--scan',action='store_true',help='Report black/frozen intervals as warnings')
    sub.add_argument('--report',type=Path,required=True)
    args = parser.parse_args()
    data, stream, fps, frames = probe(args.video)
    duration = float(stream.get('duration',data['format']['duration']))
    if args.command == 'verify':
        expected = round(args.duration*args.fps)
        if args.width <= 0 or args.height <= 0 or args.fps <= 0 or args.duration <= 0 or abs(expected-args.duration*args.fps)>1e-6:
            raise ValueError('Invalid expected specification')
        failures = []
        if (stream['width'],stream['height']) != (args.width,args.height):
            failures.append('resolution mismatch')
        if abs(fps-args.fps)>1e-6:
            failures.append('fps mismatch')
        if frames != expected:
            failures.append(f'frame count {frames} != {expected}')
        if abs(duration-args.duration)>1/args.fps:
            failures.append('duration mismatch')
        if stream['codec_name'] != 'h264' or stream.get('pix_fmt') != 'yuv420p':
            failures.append('expected H.264 yuv420p')
        audio = [s for s in data['streams'] if s['codec_type'] == 'audio']
        if args.audio == 'forbid' and audio or args.audio == 'require' and not audio:
            failures.append('audio requirement mismatch')
        decoded = subprocess.run(['ffmpeg','-v','error','-xerror','-i',str(args.video),'-f','null','-'],capture_output=True,text=True)
        if decoded.returncode:
            failures.append('full decode failed')
        warnings = []
        if args.scan:
            scan = run(['ffmpeg','-v','info','-i',str(args.video),'-vf','blackdetect=d=0.3:pix_th=0.06,freezedetect=n=0.002:d=1.5','-an','-f','null','-']).stderr
            warnings = [line.strip() for line in scan.splitlines() if re.search(r'black_start:|freeze_(start|end|duration):',line)]
        report = {'video':str(args.video.resolve()),'width':stream['width'],'height':stream['height'],
                  'fps':fps,'duration':duration,'frames':frames,'expected_frames':expected,
                  'audio_streams':len(audio),'decode_passed':decoded.returncode == 0,
                  'parameter_passed':not failures,'failures':failures,'warnings':warnings,
                  'visual_review':'not assessed by this tool'}
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({'report':str(args.report),'parameter_passed':not failures,'failures':failures},ensure_ascii=False))
        return 1 if failures else 0

    start = args.start if args.command == 'strip' else 0
    end = args.end if args.command == 'strip' else duration
    if not 0 <= start < end <= duration+1e-6 or args.step <= 0 or args.columns < 1 or args.width < 32:
        raise ValueError('Invalid sample interval or sheet geometry')
    count = math.ceil((end-start)/args.step-1e-9)
    if count > 120:
        raise ValueError('Use a larger step or shorter interval (maximum 120 samples)')
    indices = sorted({min(frames-1,round((start+i*args.step)*fps)) for i in range(count)})
    if not indices or indices[0] < 0:
        raise ValueError('Video has no sampleable frames')
    rows = math.ceil(len(indices)/args.columns)
    select = '+'.join(f'eq(n,{i})' for i in indices)
    filters = f"select='{select}',scale={args.width}:-2,drawtext=text='%{{pts\\:hms}}':x=4:y=4:fontsize=14:fontcolor=yellow:box=1:boxcolor=black@0.6,tile={args.columns}x{rows}:nb_frames={len(indices)}:padding=3:color=gray"
    args.output.parent.mkdir(parents=True,exist_ok=True)
    run(['ffmpeg','-v','error','-y','-i',str(args.video),'-vf',filters,'-frames:v','1',str(args.output)])
    report_path = args.report or Path(str(args.output)+'.json')
    report_path.parent.mkdir(parents=True,exist_ok=True)
    report_path.write_text(json.dumps({'video':str(args.video.resolve()),'output':str(args.output.resolve()),
        'native_frame_indices':indices,'sample_times':[round(i/fps,6) for i in indices],
        'fps':fps,'note':'Inspect the image; timestamps correspond to selected native frames.'},ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'image':str(args.output),'report':str(report_path),'samples':len(indices)},ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError,OSError,KeyError,ZeroDivisionError) as exc:
        print(f'Review failed: {exc}',file=sys.stderr)
        sys.exit(1)
