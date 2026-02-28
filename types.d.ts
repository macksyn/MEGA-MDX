
declare module '*.ts' {}

interface PluginContext {
  chatId: string;
  sender: string;
  isGroup: boolean;
  isOwner: boolean;
  isSudo: boolean;
  isAdmin: boolean;
  isBotAdmin: boolean;
  command: string;
  args: string[];
  text: string;
  prefix: string;
  quoted: any;
  message: any;
  sock: any;
  store: any;
  game?: any;
  id?: string;
  [key: string]: any;
}
