#!/usr/bin/env node
const USAGE = `fmux — one Feishu chat for all your tmux sessions

  fmux                    run the hub in the foreground (the service runs this)
  fmux setup [--force]    create the Feishu bot app with a QR code, then bind yourself as its owner
  fmux setup --app-id cli_xxx [--from-lark-channel-bridge] [--lark]
                          use a bot app you already have, then bind yourself as its owner
  fmux pair               bind the owner again: the sender of the next direct message to the bot
  fmux install-service    install and start the systemd user service
  fmux doctor             show what is in place and what is missing
  fmux --fake             run against tmux with Feishu replaced by a recorder (development)

Talk to the running hub with fmuxctl. Guide: docs/setup.zh.md`;

const [command, ...rest] = process.argv.slice(2);

async function main() {
  switch (command) {
    case undefined:
    case 'run':
    case '--fake': {
      const { runDaemon } = await import('../src/daemon.mjs');
      return runDaemon({ fake: command === '--fake' || rest.includes('--fake') || process.env.FMUX_FAKE === '1' });
    }
    case 'setup': {
      const { createApp, pair, promptHidden, useExistingApp } = await import('../src/setup.mjs');
      const force = rest.includes('--force');
      const at = rest.indexOf('--app-id');
      if (at >= 0) {
        const fromBridge = rest.includes('--from-lark-channel-bridge');
        const secret = fromBridge ? undefined : await promptHidden('App Secret（输入不显示）: ');
        await useExistingApp({ appId: rest[at + 1], secret, fromBridge, tenant: rest.includes('--lark') ? 'lark' : 'feishu', force });
      } else {
        await createApp({ force });
      }
      await pair();
      console.log('\n下一步：fmux install-service');
      return process.exit(0);
    }
    case 'pair': {
      const { pair } = await import('../src/setup.mjs');
      await pair();
      return process.exit(0);
    }
    case 'install-service': {
      const { installService } = await import('../src/setup.mjs');
      return installService();
    }
    case 'doctor': {
      const { doctor } = await import('../src/setup.mjs');
      return doctor();
    }
    default:
      console.log(USAGE);
      return undefined;
  }
}

main().catch((err) => {
  console.error(`fmux: ${err.message}`);
  process.exit(1);
});
