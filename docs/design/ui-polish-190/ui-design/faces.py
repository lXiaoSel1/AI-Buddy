# per-character eye positions (source px on the 300x360 pet image) -> centered avatar crops
import sys, json
from PIL import Image, ImageDraw
EYES = {  # (left eye x, right eye x, eye y)
 'deepseek':(106,166,156),'claude':(125,178,113),'chatgpt':(111,166,133),'gemini':(118,177,142),
 'kimi':(117,166,112),'grok':(128,176,160),'seed':(89,143,110),'qwen':(126,180,123),
 'minimax':(138,185,115),'glm':(122,172,123),'hunyuan':(120,174,127)}
def circle(i):
    l,r,y=EYES[i]; es=r-l; d=max(2.7*es,125); cx=(l+r)/2; cy=max(y-0.17*d,d/2)
    return cx,cy,d
if __name__=='__main__':
    ids=list(EYES)
    S=Image.new('RGB',(11*130,250),(235,237,242)); D=ImageDraw.Draw(S)
    for k,i in enumerate(ids):
        im=Image.open(f'ai-theme/art/pet-{i}.webp').convert('RGBA')
        cx,cy,d=circle(i); box=(cx-d/2,cy-d/2,cx+d/2,cy+d/2)
        c=im.crop(tuple(int(v) for v in box)).resize((100,100),Image.LANCZOS)
        m=Image.new('L',(100,100),0); ImageDraw.Draw(m).ellipse((0,0,99,99),fill=255)
        bg=Image.new('RGBA',(100,100),(255,255,255,255)); bg.alpha_composite(c); S.paste(bg.convert('RGB'),(k*130+15,10),m)
        t=im.crop((0,0,300,240)).resize((113,90)); b2=Image.new('RGBA',t.size,(255,255,255,255)); b2.alpha_composite(t)
        dd=ImageDraw.Draw(b2); l,r,y=EYES[i]; s=113/300
        for x in (l,r): dd.ellipse((x*s-2,y*s-2,x*s+2,y*s+2),outline=(255,0,0))
        dd.ellipse(((cx-d/2)*s,(cy-d/2)*s,(cx+d/2)*s,(cy+d/2)*s),outline=(0,160,0))
        S.paste(b2.convert('RGB'),(k*130+8,125)); D.text((k*130+30,228),i,fill=(0,0,0))
    S.save('ui-design/snaps/faces-new.png')
    print(json.dumps({i:[round(v,1) for v in circle(i)] for i in ids}))
