import { BadRequestException, Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser, type AuthenticatedUser } from '../common/decorators/current-user.decorator';
import {
  FinancialAuditQueryDto,
  FinancialSummaryQueryDto,
  PaymentReconciliationQueryDto,
  WithdrawalReconciliationQueryDto,
} from './dto/financial.dto';
import { FinancialService } from './financial.service';

/**
 * Financial Control & Reconciliation Centre — ADMIN-ONLY read endpoints.
 *
 * Every route requires the ADMIN role (enforced by the global RolesGuard via
 * the controller-level @Roles decorator). Read endpoints are not audited;
 * the one write-flavoured action (CSV report export) is audited with the
 * actor identity (REPORT_EXPORTED).
 */
@Roles('ADMIN')
@Controller('admin/financial')
export class FinancialController {
  constructor(private readonly financial: FinancialService) {}

  @Get('summary')
  async summary(@Query() query: FinancialSummaryQueryDto) {
    return this.financial.summary(query);
  }

  @Get('reconciliation/payments')
  async paymentReconciliation(@Query() query: PaymentReconciliationQueryDto) {
    return this.financial.paymentReconciliation(query);
  }

  @Get('reconciliation/withdrawals')
  async withdrawalReconciliation(@Query() query: WithdrawalReconciliationQueryDto) {
    return this.financial.withdrawalReconciliation(query);
  }

  @Get('reconciliation/ledger-integrity')
  async ledgerIntegrity() {
    return this.financial.ledgerIntegrity();
  }

  /**
   * CSV report export. `type` may arrive as `daily-closing` or
   * `daily-closing.csv`; anything else is rejected. The response is written
   * directly to the express response (bypassing the JSON BigInt serializer —
   * amounts are already rendered as plain minor-unit digits in the CSV).
   */
  @Get('reports/:type')
  async report(
    @Param('type') rawType: string,
    @Res() res: Response,
    @CurrentUser() admin: AuthenticatedUser,
  ) {
    if (!admin) throw new BadRequestException('Missing authenticated admin');
    const type = this.financial.parseReportType(rawType);
    const csv = await this.financial.buildReport(type);
    await this.financial.recordReportExport(type, admin);
    const filename = this.financial.reportFilenameFor(type);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  }

  @Get('audit')
  async audit(@Query() query: FinancialAuditQueryDto) {
    return this.financial.listAudit(query);
  }
}
