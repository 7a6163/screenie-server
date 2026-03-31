#!/usr/bin/env node

const Koa = require('koa');
const winston = require('winston');
const puppeteer = require('puppeteer-core');
const { Pool } = require('lightning-pool');
const { combine, timestamp, printf } = winston.format;

const loggerFormat = printf(({ message, timestamp }) => {
  return `[${timestamp}] ${message}`;
});

const logger = winston.createLogger({
  level: process.env.SCREENIE_LOG_LEVEL || 'info',
  format: combine(timestamp(), loggerFormat),
  transports: [
    new winston.transports.Console({
      timestamp: () => new Date().toISOString(),
    }),
  ],
});

logger.log('verbose', 'Setting up defaults from environment');
const chromiumArgs = process.env.SCREENIE_CHROMIUM_ARGS
  ? { args: process.env.SCREENIE_CHROMIUM_ARGS.split(' ') }
  : {};
if (!process.env.SCREENIE_CHROMIUM_EXEC) {
  logger.log('error', 'SCREENIE_CHROMIUM_EXEC must be set (puppeteer-core requires an explicit executable path)');
  process.exit(1);
}
const chromiumExec = { executablePath: process.env.SCREENIE_CHROMIUM_EXEC };
const defaultFormat = process.env.SCREENIE_DEFAULT_FORMAT || 'jpeg';
const imageSize = {
  width: parseInt(process.env.SCREENIE_WIDTH, 10) || 1024,
  height: parseInt(process.env.SCREENIE_HEIGHT, 10) || 768,
};
const serverPort = parseInt(process.env.SCREENIE_PORT, 10) || 3000;
const supportedFormats = ['jpg', 'jpeg', 'pdf', 'png'];
const allowFileScheme = process.env.SCREENIE_ALLOW_FILE_SCHEME === 'true';
const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'metadata.google.internal'];
const blockedIPRanges = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

const app = new Koa();
logger.log('verbose', 'Created KOA server');

const puppeteerArgs = Object.assign({}, chromiumArgs, chromiumExec);
const browserFactory = {
  create: async () => {
    const browser = await puppeteer.launch(puppeteerArgs);
    logger.log('verbose', `Launched browser with PID ${browser.process().pid}`);
    return browser;
  },
  destroy: async (browser) => {
    const pid = browser.process()?.pid;
    logger.log('verbose', `Closing browser with PID ${pid}`);
    await browser.close();
  },
  validate: async (browser) => {
    return browser.isConnected();
  },
};

const pool = new Pool(browserFactory, {
  min: parseInt(process.env.SCREENIE_POOL_MIN, 10) || 2,
  max: parseInt(process.env.SCREENIE_POOL_MAX, 10) || 10,
  acquireTimeoutMillis: 30000,
  idleTimeoutMillis: 60000,
});

const screenshotDelay = parseInt(process.env.SCREENIE_SCREENSHOT_DELAY, 10) || 0;

pool.start();
logger.log('verbose', 'Created Puppeteer pool');

/*
 * Clean up the Puppeteer pool before exiting when receiving a termination
 * signal. Exit with status code 143 (128 + SIGTERM's signal number, 15).
 */
process.on('SIGTERM', () => {
  logger.log('info', 'Received SIGTERM, exiting...');
  pool
    .close(5000)
    .then(() => process.exit(143))
    .catch(error => {
      logger.log('error', `Error during shutdown: ${error.message}`);
      process.exit(1);
    });
});

app.use(async (ctx, next) => {
  if (ctx.path === '/health') {
    ctx.status = 200;
    ctx.body = 'ok';
    return;
  }
  await next();
});

/**
 * Set up a Puppeteer instance for a page and configure viewport size.
 */
app.use(async (ctx, next) => {
  const { width, height } = ctx.request.query;
  const size = {
    width: Math.min(2048, parseInt(width, 10) || imageSize.width),
    height: Math.min(2048, parseInt(height, 10) || imageSize.height),
  };
  logger.log(
    'verbose',
    `Instantiating Page with size ${size.width}x${size.height}`
  );

  const browser = await pool.acquire();
  let shouldRelease = true;

  try {
    const pid = browser.process().pid;
    logger.log('verbose', `Using browser instance with PID ${pid}`);

    const page = await browser.newPage();
    ctx.state.page = page;
    logger.log('verbose', 'Set page instance on state');

    await page.setViewport(size);
    logger.log('verbose', 'Set viewport for page');

    try {
      await next();
    } finally {
      if (ctx.state.page) {
        await ctx.state.page.close().catch(() => {});
      }
    }
  } catch (error) {
    if (!browser.isConnected()) {
      logger.log('verbose', `Destroying disconnected browser`);
      shouldRelease = false;
      pool.destroy(browser);
    }
    throw error;
  } finally {
    if (shouldRelease) {
      pool.release(browser);
    }
  }
});

/**
 * Attempt to load given URL in the Puppeteer page.
 *
 * Throws 400 Bad Request if no URL is provided, and 404 Not Found if
 * Puppeteer could not load the URL.
 */
app.use(async (ctx, next) => {
  const { page } = ctx.state;
  const { url } = ctx.request.query;

  let errorStatus = null;

  if (!url) {
    ctx.throw(400, 'No url request parameter supplied.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (e) {
    ctx.throw(400, 'Invalid URL.');
  }

  if (parsedUrl.protocol === 'file:' && !allowFileScheme) {
    ctx.throw(403, 'file:// scheme is not allowed.');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'file:') {
    ctx.throw(400, 'Only http, https, and file protocols are supported.');
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (blockedHosts.includes(hostname) || blockedIPRanges.some(re => re.test(hostname))) {
    ctx.throw(403, 'Access to internal addresses is not allowed.');
  }

  logger.log('verbose', `Attempting to load ${url}`);

  try {
    const response = await page.goto(url, { waitUntil: 'networkidle0' });

    if (!response) {
      errorStatus = 502;
      throw new Error('No response from page');
    }

    const status = response.status();

    if (status < 200 || status > 299) {
      errorStatus = status;
      throw new Error('Non-OK server response');
    }

    await page.evaluateHandle('document.fonts.ready');

    if (screenshotDelay) {
      await new Promise(resolve => setTimeout(resolve, screenshotDelay));
    }
  } catch (error) {
    // Sets a catch-all error status for cases where `page.goto` throws
    if (!errorStatus) {
      errorStatus = 500;
    }
  }

  if (errorStatus) {
    ctx.throw(errorStatus);
  }

  await next();
});

/**
 * Determine the format of the output based on the `format` query parameter.
 *
 * The format must be among the formats supported by Puppeteer, else 400
 * Bad Request is thrown. If no format is provided, the default is used.
 */
app.use(async (ctx, next) => {
  const { format = defaultFormat } = ctx.request.query;

  if (supportedFormats.indexOf(format.toLowerCase()) === -1) {
    ctx.throw(400, `Format ${format} not supported.`);
  }

  ctx.type = ctx.state.format = format;

  await next();
});

/**
 * Generate a screenshot of the loaded page.
 *
 * If successful the screenshot is sent as the response.
 */
app.use(async (ctx, next) => {
  const { url, fullPage } = ctx.request.query;
  const { format, page } = ctx.state;
  const viewport = page.viewport();
  const width = viewport?.width || imageSize.width;
  const height = viewport?.height || imageSize.height;

  logger.log('info', `Rendering screenshot of ${url} to ${format}`);

  try {
    if (format === 'pdf') {
      ctx.body = await page.pdf({
        format: 'A4',
        margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' },
      });
    } else {
      const clipInfo =
        fullPage === '1'
          ? { fullPage: true }
          : { clip: { x: 0, y: 0, width, height } };
      ctx.body = await page.screenshot({
        type: format === 'jpg' ? 'jpeg' : format,
        omitBackground: true,
        ...clipInfo,
      });
    }
  } catch (error) {
    ctx.throw(400, `Could not render page: ${error.message}`);
  }

  await next();
});

app.on('error', (error) => {
  logger.log('error', error.message);
});

app.listen(serverPort);
logger.log('info', `Screenie server started on port ${serverPort}`);
