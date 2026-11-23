"""Optional post-encoding optimization: same pixels' dimensions, all image observations.
Only enabled by the dev host for the verified DeepSeek chat channel. No model calls.
"""
from io import BytesIO
import hashlib,math,time
from PIL import Image,ImageChops,ImageStat,features,__version__ as pillow_version
POLICY={'version':'whitebox-media-v3-webp','base':'whitebox-media-v2','webp_quality':85,'min_psnr_db':40.0,'min_savings_fraction':0.20,'dimensions_unchanged':True}
def optimize_image(data,mime):
    start=time.monotonic();audit={'policy':POLICY.copy(),'applied':False,'base_sha256':hashlib.sha256(data).hexdigest(),'base_bytes':len(data),'pillow_version':pillow_version,'model_calls':0,'repair_budget_used':0}
    def finish(payload,kind,reason):
        audit.update(reason=reason,seconds=time.monotonic()-start,bytes_saved=len(data)-len(payload));return payload,kind,audit
    if mime!='image/jpeg':return finish(data,mime,'retain_non_jpeg')
    if not features.check('webp'):return finish(data,mime,'webp_unavailable')
    audit['webp_version']=features.version('webp')
    try:
        with Image.open(BytesIO(data)) as opened:
            original=opened.convert('RGB');encoded=BytesIO();original.save(encoded,format='WEBP',quality=POLICY['webp_quality'],method=6);candidate=encoded.getvalue()
            audit['candidate_bytes']=len(candidate)
            if len(candidate)>len(data)*(1-POLICY['min_savings_fraction']):return finish(data,mime,'insufficient_savings')
            with Image.open(BytesIO(candidate)) as decoded:
                if decoded.size!=original.size:raise ValueError('Dimensions changed')
                error=ImageStat.Stat(ImageChops.difference(original,decoded.convert('RGB'))).rms;mse=sum(x*x for x in error)/3
            psnr=100.0 if not mse else 10*math.log10(255**2/mse);audit['psnr_vs_base_jpeg_db']=round(psnr,4)
            if psnr<POLICY['min_psnr_db']:return finish(data,mime,'pixel_error_exceeds_policy')
            audit['applied']=True;return finish(candidate,'image/webp','same_dimensions_smaller_encoding')
    except Exception as error:
        # Encoding is optional; preserve the already validated JPEG on any failure.
        audit['encoder_error']=type(error).__name__;return finish(data,mime,'encoder_fallback')
