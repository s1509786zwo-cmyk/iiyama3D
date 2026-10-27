import json,struct,sys,os
import numpy as np

class GLB:
    def __init__(self,path):
        d=open(path,'rb').read()
        magic,ver,ln=struct.unpack_from('<4sII',d,0)
        off=12; self.js=None; self.bin=None
        while off<ln:
            clen,ctype=struct.unpack_from('<I4s',d,off); off+=8
            c=d[off:off+clen]; off+=clen
            if ctype==b'JSON': self.js=json.loads(c)
            elif ctype[:3]==b'BIN': self.bin=c
        self.g=self.js
        self.np_dtype={5120:np.int8,5121:np.uint8,5122:np.int16,5123:np.uint16,5125:np.uint32,5126:np.float32}
        self.np_n={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}
    def acc(self,i):
        a=self.g['accessors'][i]; bv=self.g['bufferViews'][a['bufferView']]
        dt=self.np_dtype[a['componentType']]; n=self.np_n[a['type']]
        start=bv.get('byteOffset',0)+a.get('byteOffset',0)
        count=a['count']; stride=bv.get('byteStride') or n*np.dtype(dt).itemsize
        raw=np.frombuffer(self.bin,dtype=np.uint8,count=stride*count,offset=start).reshape(count,stride)
        return raw[:,:n*np.dtype(dt).itemsize].copy().view(dt).reshape(count,n)
    def node_matrix(self,n):
        if 'matrix' in n: return np.array(n['matrix'],dtype=np.float64).reshape(4,4).T
        M=np.eye(4)
        if 'scale' in n: M[:3,:3]=np.diag(n['scale'])
        if 'rotation' in n:
            x,y,z,w=n['rotation']
            R=np.array([[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
                        [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
                        [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]])
            M[:3,:3]=R@M[:3,:3]
        if 'translation' in n: M[:3,3]=n['translation']
        return M

def walk_nodes(g):
    I=np.eye(4); out=[]
    def rec(idx,P):
        n=g['nodes'][idx]; M=P@GLB.__dict__ and None
    return out

def collect(path):
    G=GLB(path); g=G.g
    verts=[]; nodeinfo=[]; tris=0
    def rec(idx,P,depth):
        nonlocal tris
        n=g['nodes'][idx]; M=P@G.node_matrix(n)
        if 'mesh' in n:
            for pi,p in enumerate(g['meshes'][n['mesh']]['primitives']):
                pos=G.acc(p['attributes']['POSITION']).astype(np.float64)
                v=(pos@M[:3,:3].T)+M[:3,3]
                verts.append(v)
                if 'indices' in p: tris+=g['accessors'][p['indices']]['count']//3
                else: tris+=len(v)//3
                nodeinfo.append((n.get('name'),g['meshes'][n['mesh']].get('name'),len(v),v.min(0),v.max(0)))
        for c in n.get('children',[]): rec(c,M,depth+1)
    sc=g['scenes'][g.get('scene',0)]
    for r in sc['nodes']: rec(r,np.eye(4),0)
    V=np.concatenate(verts) if verts else np.zeros((0,3))
    return G,V,nodeinfo,tris

if __name__=='__main__':
    path=sys.argv[1]; mode=sys.argv[2] if len(sys.argv)>2 else 'all'
    G,V,ni,tris=collect(path)
    g=G.g
    print("="*72); print(os.path.basename(path),"verts",len(V),"tris",tris)
    mn,mx=V.min(0),V.max(0)
    print("world min",np.round(mn,2),"max",np.round(mx,2),"size",np.round(mx-mn,2))
    if mode in ('all','nodes'):
        print("--- per-mesh nodes (name | mesh | verts | min | max) ---")
        for n in ni:
            print(f"  {str(n[0])[:38]:38s} | {str(n[1])[:26]:26s} | {n[2]:7d} | {np.round(n[3],1)} | {np.round(n[4],1)}")
    if mode in ('all','hist'):
        y=V[:,1]
        hist,edges=np.histogram(y,bins=120)
        print("--- Y (height) histogram, biggest peaks ---")
        idx=np.argsort(hist)[::-1][:18]
        for i in sorted(idx):
            print(f"   y={edges[i]:8.2f} .. {edges[i+1]:8.2f}  count={hist[i]}")
        print("--- X/Z occupancy ---")
        for ax,lab in ((0,'X'),(2,'Z')):
            h,e=np.histogram(V[:,ax],bins=40)
            print(f"  {lab}: range {e[0]:.2f}..{e[-1]:.2f}")
    if mode in ('all','imgs'):
        print("--- images ---")
        for i,im in enumerate(g.get('images',[])):
            bv=im.get('bufferView'); sz=g['bufferViews'][bv]['byteLength'] if bv is not None else 0
            # parse png/jpeg dims
            b=G.bin[g['bufferViews'][bv].get('byteOffset',0):][:64]
            dim=''
            if b[:8]==b'\x89PNG\r\n\x1a\n':
                w,h=struct.unpack('>II',b[16:24]); dim=f"{w}x{h} png"
            elif b[:2]==b'\xff\xd8':
                j=2
                while j<len(b)-9:
                    if b[j]!=0xFF: j+=1; continue
                    m=b[j+1]
                    if m in (0xC0,0xC1,0xC2):
                        h,w=struct.unpack('>HH',b[j+5:j+9]); dim=f"{w}x{h} jpeg"; break
                    j+=2+struct.unpack('>H',b[j+2:j+4])[0]
            print(f"  img{i:02d} {im.get('mimeType')} {sz/1e6:.2f}MB {im.get('name','')} {dim}")
