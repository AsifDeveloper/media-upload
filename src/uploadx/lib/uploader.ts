import { ErrorHandler, ErrorType } from './error-handler';
import {
  UploadAction,
  UploaderOptions,
  UploadState,
  UploadStatus,
  UploadxControlEvent
} from './interfaces';
import { store } from './store';
import { createHash, DynamicChunk, isNumber, noop, unfunc } from './utils';

const actionToStatusMap: { [K in UploadAction]: UploadStatus } = {
  pause: 'paused',
  upload: 'queue',
  cancel: 'cancelled',
  uploadAll: 'queue',
  pauseAll: 'paused',
  cancelAll: 'cancelled'
};
interface RequestParams {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  body?: BodyInit | null;
  url?: string;
  headers?: Record<string, string>;
  progress?: boolean;
}

/**
 * Uploader Base Class
 */
export abstract class Uploader implements UploadState {
  set status(s: UploadStatus) {
    if (this._status === 'cancelled' || (this._status === 'complete' && s !== 'cancelled')) {
      return;
    }
    if (s !== this._status) {
      s === 'paused' && this.abort();
      this._status = s;
      ['cancelled', 'complete', 'error'].includes(s) && this.cleanup();
      s === 'cancelled' ? this.onCancel() : this.stateChange(this);
    }
  }
  get status() {
    return this._status;
  }
  get url(): string {
    return this._url || store.get(this.uploadId) || '';
  }
  set url(value: string) {
    this._url !== value && store.set(this.uploadId, value);
    this._url = value;
  }
  readonly name: string;
  readonly size: number;
  readonly uploadId: string;
  response: any;
  responseStatus: number;
  progress: number;
  remaining: number;
  speed: number;
  uploadType?: string;
  /** Custom headers */
  headers: Record<string, any> = {};
  /** Metadata Object */
  metadata: Record<string, any>;
  /** Upload endpoint */
  endpoint = '/upload';
  /** Chunk size in bytes */
  chunkSize: number;
  /** Auth token/tokenGetter */
  token: UploadxControlEvent['token'];
  /** Retries handler */
  protected errorHandler = new ErrorHandler();
  /** Active HttpRequest */
  protected _xhr: XMLHttpRequest;
  /** byte offset within the whole file */
  protected offset? = 0;
  /** Set HttpRequest responseType */
  protected responseType: XMLHttpRequestResponseType = '';
  private _url = '';
  private _status: UploadStatus;
  private startTime: number;
  private stateChange: (evt: UploadState) => void;

  constructor(readonly file: File, readonly options: UploaderOptions) {
    this.name = file.name;
    this.size = file.size;
    this.metadata = {
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      lastModified: file.lastModified
    };
    const print = JSON.stringify({
      ...this.metadata,
      type: this.constructor.name,
      endpoint: options.endpoint
    });
    this.uploadId = createHash(print).toString(16);
    this.stateChange = options.stateChange || noop;
    this.chunkSize = options.chunkSize || this.size;
    this.configure(options);
  }

  /**
   * Configure uploader
   */
  configure({ metadata = {}, headers = {}, token, endpoint, action }: UploadxControlEvent): void {
    this.endpoint = endpoint || this.endpoint;
    this.token = token || this.token;
    this.metadata = { ...this.metadata, ...unfunc(metadata, this.file) };
    this.headers = { ...this.headers, ...unfunc(headers, this.file) };
    action && (this.status = actionToStatusMap[action]);
  }

  /**
   * Starts uploading
   */
  async upload(): Promise<void> {
    this.status = 'uploading';
    try {
      await this.getToken();
      this.offset = undefined;
      this.startTime = new Date().getTime();
      this.url = this.url || (await this.getFileUrl());
      this.errorHandler.reset();
      this.start();
    } catch {
      if (this.errorHandler.kind(this.responseStatus) !== ErrorType.FatalError) {
        this.status = 'retry';
        await this.errorHandler.wait();
        this.status = 'queue';
      } else {
        this.status = 'error';
      }
    }
  }

  /**
   * Starts chunk upload
   */
  async start() {
    while (this.status === 'uploading' || this.status === 'retry') {
      if (this.offset !== this.size) {
        try {
          const offset = isNumber(this.offset)
            ? await this.sendFileContent()
            : await this.getOffset();
          if (offset === this.offset) {
            throw new Error('Content upload failed');
          }
          this.errorHandler.reset();
          this.offset = offset;
        } catch {
          const errType = this.errorHandler.kind(this.responseStatus);
          if (this.responseStatus === 413) {
            DynamicChunk.maxSize = this.chunkSize /= 2;
          } else if (errType === ErrorType.FatalError) {
            this.status = 'error';
          } else if (errType === ErrorType.Restart) {
            this.url = '';
            this.status = 'queue';
          } else if (errType === ErrorType.Auth) {
            await this.getToken();
          } else {
            this.status = 'retry';
            await this.errorHandler.wait();
            this.offset = this.responseStatus >= 400 ? undefined : this.offset;
            this.status = 'uploading';
          }
        }
      } else {
        this.progress = 100;
        this.remaining = 0;
        this.status = 'complete';
      }
    }
  }

  /**
   * Performs http requests
   */
  request({
    method = 'GET',
    body = null,
    url,
    headers = {},
    progress
  }: RequestParams): Promise<ProgressEvent> {
    return new Promise((resolve, reject) => {
      const xhr = (this._xhr = new XMLHttpRequest());
      xhr.open(method, url || this.url, true);
      if (body instanceof Blob || (body && progress)) {
        xhr.upload.onprogress = this.onProgress();
      }
      this.responseStatus = 0;
      this.response = undefined;
      this.responseType && (xhr.responseType = this.responseType);
      this.options.withCredentials && (xhr.withCredentials = true);
      const _headers = { ...this.headers, ...headers };
      Object.keys(_headers).forEach(key => xhr.setRequestHeader(key, _headers[key]));
      xhr.onload = (evt: ProgressEvent) => {
        this.responseStatus = xhr.status;
        this.response = this.responseStatus !== 204 ? this.getResponseBody(xhr) : '';
        this.responseStatus >= 400 ? reject(evt) : resolve(evt);
      };
      xhr.onerror = reject;
      xhr.send(body);
    });
  }

  /**
   * Get file URI
   */
  protected abstract getFileUrl(): Promise<string>;

  /**
   * Send file content and return an offset for the next request
   */
  protected abstract sendFileContent(): Promise<number | undefined>;

  /**
   * Get an offset for the next request
   */
  protected abstract getOffset(): Promise<number | undefined>;

  protected setAuth(token: string) {
    this.headers.Authorization = `Bearer ${token}`;
  }

  protected abort(): void {
    this.offset = undefined;
    this._xhr && this._xhr.abort();
  }

  protected onCancel(): void {
    this.abort();
    const stateChange = () => this.stateChange(this);
    if (this.url) {
      this.request({ method: 'DELETE' }).then(stateChange, stateChange);
    } else {
      stateChange();
    }
  }

  /**
   * Gets the value from the response
   */
  protected getValueFromResponse(key: string): string | null {
    return this._xhr.getResponseHeader(key);
  }

  /**
   * Set auth token
   */
  protected getToken(): Promise<any> {
    return Promise.resolve(unfunc(this.token || '', this.responseStatus)).then(
      token => token && this.setAuth(token)
    );
  }

  protected getChunk() {
    this.chunkSize = isNumber(this.options.chunkSize) ? this.chunkSize : DynamicChunk.size;
    const start = this.offset || 0;
    const end = Math.min(start + this.chunkSize, this.size);
    const body = this.file.slice(this.offset, end);
    return { start, end, body };
  }
  private cleanup = () => store.delete(this.uploadId);

  private getResponseBody(xhr: XMLHttpRequest): any {
    let body = 'response' in (xhr as any) ? xhr.response : xhr.responseText;
    if (body && this.responseType === 'json' && typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    return body;
  }

  private onProgress(): (evt: ProgressEvent) => void {
    let throttle = 0;
    return ({ loaded }: ProgressEvent) => {
      const now = new Date().getTime();
      const uploaded = (this.offset as number) + loaded;
      const elapsedTime = (now - this.startTime) / 1000;
      this.speed = Math.round(uploaded / elapsedTime);
      DynamicChunk.scale(this.speed);
      if (!throttle) {
        throttle = window.setTimeout(() => (throttle = 0), 500);
        this.progress = +((uploaded / this.size) * 100).toFixed(2);
        this.remaining = Math.ceil((this.size - uploaded) / this.speed);
        this.stateChange(this);
      }
    };
  }
}
