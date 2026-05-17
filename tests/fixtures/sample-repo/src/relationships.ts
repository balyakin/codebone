export class BaseService {
  run() {
    return "base";
  }
}

export class BillingService extends BaseService {
  override run() {
    return "billing";
  }
}

export function audited(_target: unknown) {}

@audited
export class DecoratedBillingService {}
