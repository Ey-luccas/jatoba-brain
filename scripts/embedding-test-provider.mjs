import { createServer } from 'node:http';

const server=createServer((req,res)=>{
  if(req.method!=='POST') { res.writeHead(404); res.end(); return; }
  let body='';
  req.on('data',chunk=>{body+=chunk;});
  req.on('end',()=>{
    if(!body.includes('jatoba-health-probe')) { res.writeHead(400); res.end('{}'); return; }
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({data:[{embedding:[0.1,0.2,0.3,0.4]}]}));
  });
});

server.listen(4010,'0.0.0.0');
