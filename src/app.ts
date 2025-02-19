import type {Route} from './router/route.js';
import type {
  AnyArguments,
  AppOptions,
  UserAgentOptions,
  MojoAction,
  MojoContext,
  MojoModels,
  RouteArguments,
  ServerOptions,
  TestUserAgentOptions
} from './types.js';
import {Readable} from 'node:stream';
import {CLI} from './cli.js';
import {Context} from './context.js';
import {Hooks} from './hooks.js';
import {Logger} from './logger.js';
import {Mime} from './mime.js';
import defaultConditionsPlugin from './plugins/default-conditions.js';
import defaultHelpersPlugin from './plugins/default-helpers.js';
import tmplEnginePlugin from './plugins/tmpl-engine.js';
import {Renderer} from './renderer.js';
import {Router} from './router.js';
import {ServerRequest} from './server/request.js';
import {ServerResponse} from './server/response.js';
import {Session} from './session.js';
import {Static} from './static.js';
import {UserAgent} from './user-agent.js';
import {MockUserAgent} from './user-agent/mock.js';
import {TestUserAgent} from './user-agent/test.js';
import {Validator} from './validator.js';
import Path from '@mojojs/path';

type AppHook = (app: App, ...args: any[]) => any;
type ContextHook = (app: MojoContext, ...args: any[]) => any;

type Decoration = ((...args: any[]) => any) | {get?: () => any; set?: (value: any) => any};

const ContextWrapper = class extends Context {};

/**
 * Application class.
 */
export class App {
  /**
   * Command line interface.
   */
  cli: CLI = new CLI(this);
  /**
   * Application config.
   */
  config: Record<string, any>;
  /**
   * Default stash values.
   */
  defaults: Record<string, any> = {};
  /**
   * Detect if the application has been imported and disable the command line interface if it has.
   */
  detectImport: boolean;
  /**
   * Format for HTTP exceptions ("html", "json", or "txt").
   */
  exceptionFormat: string;
  /**
   * Application hooks.
   */
  hooks: Hooks = new Hooks();
  /**
   * Application home directory.
   */
  home: Path = new Path();
  /**
   * Application logger.
   */
  log: Logger;
  /**
   * MIME types.
   */
  mime: Mime = new Mime();
  /**
   * Operating mode for application. Defaults to the value of the `NODE_ENV` environment variable.
   */
  mode: string;
  /**
   * Storage for user defined models.
   */
  models: MojoModels = {};
  /**
   * Application renderer.
   */
  renderer: Renderer = new Renderer();
  /**
   * Application router.
   */
  router: Router = new Router();
  /**
   * Rotating secret passphrases used for signed cookies and the like.
   */
  secrets: string[];
  /**
   * Encrypted cookie based session manager.
   */
  session: Session = new Session(this);
  /**
   * Static file server.
   */
  static: Static = new Static();
  /**
   * HTTP/WebSocket user agent.
   */
  ua: UserAgent = new UserAgent();
  /**
   * JSON schema validator.
   */
  validator = new Validator();

  _contextClass: any = class extends ContextWrapper {};

  constructor(options: AppOptions = {}) {
    this.config = options.config ?? {};
    this.detectImport = options.detectImport ?? true;
    this.exceptionFormat = options.exceptionFormat ?? 'html';
    this.secrets = options.secrets ?? ['Insecure'];

    this.mode = options.mode ?? process.env.NODE_ENV ?? 'development';

    const isDev = this.mode === 'development';
    this.log = new Logger({historySize: isDev ? 10 : 0, level: isDev ? 'trace' : 'info'});

    this.plugin(defaultHelpersPlugin);
    this.plugin(defaultConditionsPlugin);
    this.plugin(tmplEnginePlugin);
  }

  /**
   * Add an application hook to extend the framework.
   */
  addAppHook(name: string, fn: AppHook): this {
    this.hooks.addHook(name, fn);
    return this;
  }

  /**
   * Add a context hook to extend the framework.
   */
  addContextHook(name: string, fn: ContextHook): this {
    this.hooks.addHook(name, fn);
    return this;
  }

  /**
   * Add a helper.
   */
  addHelper(name: string, fn: MojoAction): this {
    return this.decorateContext(name, function (this: MojoContext, ...args: any[]) {
      return fn(this, ...args);
    });
  }

  /**
   * Generate route matching any of the listed HTTP request methods or all.
   */
  any(...args: AnyArguments): Route {
    return this.router.any(...args);
  }

  /**
   * Decorate context class with a method or getter/setter.
   */
  decorateContext(name: string, fn: Decoration): this {
    const proto: MojoContext = Context.prototype as MojoContext;
    if (Object.getOwnPropertyDescriptor(proto, name) != null) {
      throw new Error(`The name "${name}" is already used in the prototype chain`);
    }

    if (typeof fn !== 'function') {
      Object.defineProperty(this._contextClass.prototype, name, fn);
    } else {
      this._contextClass.prototype[name] = fn;
    }

    return this;
  }

  /**
   * Generate route matching only `DELETE` requests.
   */
  delete(...args: RouteArguments): Route {
    return this.router.delete(...args);
  }

  /**
   * Generate route matching only `GET` requests.
   */
  get(...args: RouteArguments): Route {
    return this.router.get(...args);
  }

  /**
   * Handle a new incoming request, used by servers.
   */
  async handleRequest(ctx: MojoContext): Promise<void> {
    if ((await this.hooks.runHook('dispatch:before', ctx)) === true) return;
    if (ctx.isWebSocket !== true && (await this.static.dispatch(ctx)) === true) return;

    if ((await this.hooks.runHook('router:before', ctx)) === true) return;
    if ((await this.router.dispatch(ctx)) === true) return;

    if (ctx.isWebSocket !== true) await ctx.notFound();
  }

  /**
   * Create a context for application.
   */
  newContext(req: ServerRequest, res: ServerResponse): MojoContext {
    const ctx = new this._contextClass(this, req, res);
    Object.assign(ctx.stash, this.defaults);
    return ctx;
  }

  /**
   * Create a mock context for application. Very useful for testing helpers.
   */
  newMockContext(options: {headers?: string[]; method?: string; url?: string} = {}): MojoContext {
    const ctx: MojoContext = new this._contextClass(
      this,
      new ServerRequest({
        body: new Readable(),
        headers: options.headers ?? [],
        isSecure: false,
        isWebSocket: false,
        method: options.method ?? 'GET',
        remoteAddress: '127.0.0.1',
        reverseProxy: false,
        url: options.url ?? '/'
      }),
      new ServerResponse(() => ctx.log.trace('Mock response has been sent'))
    );
    Object.assign(ctx.stash, this.defaults);
    return ctx;
  }

  /**
   * Create a new mock user agent for application.
   */
  async newMockUserAgent(options?: UserAgentOptions, serverOptions?: ServerOptions): Promise<MockUserAgent> {
    return await MockUserAgent.newMockUserAgent(this, options, serverOptions);
  }

  /**
   * Create a new test user agent for application.
   */
  async newTestUserAgent(options?: TestUserAgentOptions, serverOptions?: ServerOptions): Promise<TestUserAgent> {
    return await TestUserAgent.newTestUserAgent(this, options, serverOptions);
  }

  /**
   * Generate route matching only `OPTIONS` requests.
   */
  options(...args: RouteArguments): Route {
    return this.router.options(...args);
  }

  /**
   * Generate route matching only `PATCH` requests.
   */
  patch(...args: RouteArguments): Route {
    return this.router.patch(...args);
  }

  /**
   * Register plugin.
   */
  plugin<T>(plugin: (app: App, options: Record<string, any>) => T, options: Record<string, any> = {}): T {
    return plugin(this, options);
  }

  /**
   * Generate route matching only `POST` requests.
   */
  post(...args: RouteArguments): Route {
    return this.router.post(...args);
  }

  /**
   * Generate route matching only `PUT` requests.
   */
  put(...args: RouteArguments): Route {
    return this.router.put(...args);
  }

  /**
   * Start the command line interface.
   */
  async start(command?: string, ...args: string[]): Promise<void> {
    if (this.detectImport === true && process.argv[1] !== Path.callerFile().toString()) return;
    return this.cli.start(command, ...args).catch(error => this.log.error(error.message));
  }

  /**
   * Generate route for a nested route with its own intermediate destination.
   */
  under(...args: AnyArguments): Route {
    return this.router.under(...args);
  }

  /**
   * Warmup the cache, usually called automatically.
   */
  async warmup(): Promise<void> {
    await Promise.all([this.static, this.renderer, this.router].map(component => component.warmup()));
    await this.hooks.runHook('app:warmup', this);
  }

  /**
   * Generate route matching only WebSocket handshake requests.
   */
  websocket(...args: RouteArguments): Route {
    return this.router.websocket(...args);
  }
}
