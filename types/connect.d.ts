/// <reference types="node" />

import type { IncomingMessage, ServerResponse } from 'http';

export declare namespace Connect {
  type NextFunction = (err?: any) => void;
  type ErrorHandleFunction = (
    err: any,
    req: IncomingMessage,
    res: ServerResponse,
    next: NextFunction,
  ) => void;
}
