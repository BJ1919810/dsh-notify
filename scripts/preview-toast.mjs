/**
 * Show the exact notification dsh-notify would produce for a finished task, so
 * its layout can be checked by eye. Development helper; not shipped.
 */
import { buildNotification } from '../lib/format.js';
import { showToast } from '../lib/powershell-toast.js';

const payload = buildNotification({
  kind: 'completed',
  title: '给 DSH 加一个任务完成通知插件',
  cwd: 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\default-workspace',
  summary:
    '## 完成\n已实现 Windows 原生通知：**监听 turn/end 与 agent/status**，在 agent 真正空闲时弹出通知，' +
    '目标模式下只在整个目标结束时通知一次。测试 33 项全部通过。',
});

console.log('title:', payload.title);
console.log('body :', payload.body);
console.log('sound:', payload.sound);

const { outcome } = showToast({
  title: payload.title,
  body: payload.body,
  sound: payload.sound,
});
console.log('result:', await outcome);
