#!/usr/bin/env node
const USAGE = `fmux — one Feishu chat for all your tmux sessions

  fmux                    run the hub in the foreground (the service runs this)
  fmux setup [--force]    create the Feishu bot app with a QR code, then bind yourself as its owner
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
      const { createApp, pair } = await import('../src/setup.mjs');
      await createApp({ force: rest.includes('--force') });
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
