import sys, numpy as np
sys.path.insert(0,'/home/user/iiyama3D/tools')
from analyze import GLB
from render_mesh import load
def run(path, bins=60, top=14):
    G=GLB(path); V,U,C,I=load(G); T=I.reshape(-1,3)
    v0,v1,v2=V[T[:,0]],V[T[:,1]],V[T[:,2]]
    n=np.cross(v1-v0,v2-v0); a=np.linalg.norm(n,axis=1)*0.5
    nn=n/np.maximum(np.linalg.norm(n,axis=1)[:,None],1e-12)
    cen=(v0+v1+v2)/3
    mn,mx=V.min(0),V.max(0); size=mx-mn
    print("="*78); print(path.split('/')[-1]," size",np.round(size,1)," min",np.round(mn,2),"max",np.round(mx,2))
    print(" dominant normal axes by area:")
    for ax,lab in enumerate('XYZ'):
        print(f"   {lab}: +{a[nn[:,ax]>0.95].sum():9.0f} -{a[nn[:,ax]<-0.95].sum():9.0f}")
    for ax,lab,sgn in ((1,'Y+ (top surfaces / floor / desks)',1),(1,'Y- (ceilings / undersides)',-1),(0,'X walls',None),(2,'Z walls',None)):
        if sgn is None:
            m=np.abs(nn[:,ax])>0.95
        else:
            m=(nn[:,ax]*sgn)>0.95
        if not m.any(): continue
        h,e=np.histogram(cen[m,ax],bins=bins,weights=a[m])
        idx=np.argsort(h)[::-1][:top]
        print(f" -- {lab} : area-weighted height histogram peaks (axis {('XYZ')[ax]})")
        for i in sorted(idx):
            if h[i]<=0: continue
            print(f"     {e[i]:9.2f}..{e[i+1]:9.2f}  area={h[i]:9.1f}")
    return V,I,nn,a,cen
if __name__=='__main__': run(sys.argv[1], int(sys.argv[2]) if len(sys.argv)>2 else 60)
