import sys, io, numpy as np
from PIL import Image
sys.path.insert(0,'/home/user/iiyama3D/tools')
from analyze import GLB

def load(G):
    g=G.g; texcache={}
    verts=[];uvs=[];cols=[];idx=[];norms=[];base=0
    def texarr(i):
        if i in texcache: return texcache[i]
        im=g['images'][i]; bv=g['bufferViews'][im['bufferView']]
        o=bv.get('byteOffset',0); l=bv['byteLength']
        a=np.asarray(Image.open(io.BytesIO(G.bin[o:o+l])).convert('RGBA')).astype(np.float32)/255.
        texcache[i]=a; return a
    def rec(ni,P):
        nonlocal base
        n=g['nodes'][ni]; M=P@G.node_matrix(n)
        if 'mesh' in n:
            for p in g['meshes'][n['mesh']]['primitives']:
                if p.get('mode',4)!=4: continue
                pos=G.acc(p['attributes']['POSITION']).astype(np.float64)
                v=(pos@M[:3,:3].T)+M[:3,3]
                mi=p.get('material',0); mat=g['materials'][mi] if g.get('materials') else {}
                pbr=mat.get('pbrMetallicRoughness',{})
                sg=mat.get('extensions',{}).get('KHR_materials_pbrSpecularGlossiness',{})
                bcol=np.array(pbr.get('baseColorFactor') or sg.get('diffuseFactor') or [1,1,1,1],dtype=np.float32)
                tex=pbr.get('baseColorTexture') or sg.get('diffuseTexture')
                if 'TEXCOORD_0' in p['attributes']: uv=G.acc(p['attributes']['TEXCOORD_0']).astype(np.float64)
                else: uv=np.zeros((len(v),2))
                if tex is not None:
                    src=g['textures'][tex['index']].get('source')
                    if src is not None:
                        arr=texarr(src); h,w=arr.shape[:2]
                        px=np.clip((uv[:,0]%1.0)*(w-1),0,w-1).astype(np.int32)
                        py=np.clip((1.0-(uv[:,1]%1.0))*(h-1),0,h-1).astype(np.int32)
                        c=arr[py,px][:,:3]*bcol[:3]
                    else: c=np.tile(bcol[:3],(len(v),1))
                else: c=np.tile(bcol[:3],(len(v),1))
                verts.append(v); uvs.append(uv); cols.append(c)
                if 'indices' in p:
                    ii=G.acc(p['indices']).astype(np.int64).reshape(-1)
                else:
                    ii=np.arange(len(v),dtype=np.int64)
                idx.append(ii+base); base+=len(v)
        for c in n.get('children',[]): rec(c,M)
    for r in g['scenes'][g.get('scene',0)]['nodes']: rec(r,np.eye(4))
    return (np.concatenate(verts),np.concatenate(uvs),np.concatenate(cols),np.concatenate(idx))

def render(V,C,I,eye,target,up,W=900,H=680,fov=55,light=np.array([0.4,0.8,0.45]),exposure=1.0):
    f=target-eye; f/=np.linalg.norm(f); r=np.cross(f,up); r/=np.linalg.norm(r); u=np.cross(r,f)
    rel=V-eye; x=rel@r; y=rel@u; z=rel@f
    fp=1.0/np.tan(np.radians(fov)*0.5); asp=W/H
    zz=np.maximum(z,1e-4)
    sx=W*0.5+(x*fp/asp/zz)*W*0.5; sy=H*0.5-(y*fp/zz)*H*0.5
    T=I.reshape(-1,3)
    if len(T)==0: return np.zeros((H,W,3),np.uint8)
    v0,v1,v2=T[:,0],T[:,1],T[:,2]
    sx0,sy0,z0=sx[v0],sy[v0],z[v0]; sx1,sy1,z1=sx[v1],sy[v1],z[v1]; sx2,sy2,z2=sx[v2],sy[v2],z[v2]
    vis=(z0>1e-3)&(z1>1e-3)&(z2>1e-3)
    area=(sx1-sx0)*(sy2-sy0)-(sx2-sx0)*(sy1-sy0)
    vis&=np.abs(area)>0.2
    img=np.zeros((H,W,3),np.float32); zb=np.full((H,W),1e30,np.float32)
    e0=np.clip(np.floor(np.minimum(np.minimum(sx0,sx1),sx2)),0,W-1).astype(np.int32)
    e1=np.clip(np.ceil(np.maximum(np.maximum(sx0,sx1),sx2)),0,W-1).astype(np.int32)
    f0=np.clip(np.floor(np.minimum(np.minimum(sy0,sy1),sy2)),0,H-1).astype(np.int32)
    f1=np.clip(np.ceil(np.maximum(np.maximum(sy0,sy1),sy2)),0,H-1).astype(np.int32)
    n0=V[v0]; n1=V[v1]; n2=V[v2]
    nrm=np.cross(n1-n0,n2-n0); ln=np.linalg.norm(nrm,axis=1); ln[ln<1e-12]=1; nrm/=ln[:,None]
    L=light/np.linalg.norm(light)
    lam=np.abs(nrm@L)*0.55+0.75
    face_col=(C[v0]+C[v1]+C[v2])/3.0*lam[:,None]
    for k in np.nonzero(vis)[0]:
        x0,x1=int(e0[k]),int(e1[k]); y0,y1=int(f0[k]),int(f1[k])
        if x1<=x0 or y1<=y0: continue
        xs=np.arange(x0,x1+1)+0.5; ys=np.arange(y0,y1+1)+0.5
        PX,PY=np.meshgrid(xs,ys)
        ax,ay=sx0[k],sy0[k]; bx,by=sx1[k],sy1[k]; cx,cy=sx2[k],sy2[k]
        ar=(bx-ax)*(cy-ay)-(cx-ax)*(by-ay)
        if abs(ar)<1e-9: continue
        w0=((bx-PX)*(cy-PY)-(cx-PX)*(by-PY))/ar
        w1=((cx-PX)*(ay-PY)-(ax-PX)*(cy-PY))/ar
        w2=1.0-w0-w1
        m=(w0>=0)&(w1>=0)&(w2>=0)
        if not m.any(): continue
        iz=w0/z0[k]+w1/z1[k]+w2/z2[k]
        with np.errstate(divide='ignore'):
            dep=1.0/np.maximum(iz,1e-12)
        sub=zb[y0:y1+1,x0:x1+1]
        mm=m&(dep<sub)
        if not mm.any(): continue
        sub[mm]=dep[mm]
        imgs=img[y0:y1+1,x0:x1+1]
        imgs[mm]=face_col[k]
    # light background gradient
    bg=np.zeros_like(img)
    grad=(np.arange(H,dtype=np.float32)/H)[:,None,None]*0.10+0.03
    bg[:]=grad
    img=np.where(img.sum(2,keepdims=True)>0,img,bg)
    return (np.clip(img*exposure,0,1)*255).astype(np.uint8)

def cam_views(V,names=('iso','front','side','top'),dist_mul=1.0):
    mn,mx=V.min(0),V.max(0); ctr=(mn+mx)/2; size=np.linalg.norm(mx-mn)
    d=size*0.95*dist_mul; up=np.array([0,1,0.])
    return {
     'iso':(ctr+np.array([d*0.62,d*0.42,d*0.62]),ctr,up),
     'front':(ctr+np.array([0,d*0.05,d]),ctr,up),
     'side':(ctr+np.array([d,0.001,d*0.001]),ctr,up),
     'top':(ctr+np.array([0.001,d,0.001]),ctr,np.array([0,0,-1.])),
    }

if __name__=='__main__':
    path=sys.argv[1]; out=sys.argv[2]; keys=sys.argv[3].split(',') if len(sys.argv)>3 else ['iso','front','side','top']
    G=GLB(path); V,U,C,I=load(G)
    print("verts",len(V),"idx",len(I)//3)
    cams=cam_views(V)
    for k in keys:
        eye,t,up=cams[k]
        img=render(V,C,I,eye,t,up)
        Image.fromarray(img).save(f"{out}_{k}.png"); print("wrote",f"{out}_{k}.png")
