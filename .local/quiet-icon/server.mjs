import {createServer} from 'vite';
import reactNativeWeb from 'vite-plugin-react-native-web';
const server=await createServer({root:process.cwd()+'/.local/quiet-icon',configFile:false,esbuild:{jsx:'automatic'},plugins:[reactNativeWeb(),{name:'idle-activity-input',enforce:'pre',resolveId(id){if(id.endsWith('/hooks/useAliaActivity'))return '\0idle-activity';},load(id){if(id==='\0idle-activity')return "export const useAliaActivity=()=> 'idle';";}}],server:{host:'127.0.0.1',port:6021,strictPort:true,fs:{allow:[process.cwd()]}}});await server.listen();console.log('quiet icon6021');
