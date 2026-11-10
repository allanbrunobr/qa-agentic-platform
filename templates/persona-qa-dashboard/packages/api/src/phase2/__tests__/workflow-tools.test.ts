import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ToolRegistry } from '../services/tool-registry.js'
import {
  registerCustomerHandler,
  fulfillOrderHandler,
  findInvoiceByOrderIdHandler,
  openOrderDetailsHandler,
  createOrderHandler,
  verifyFinanceDashboardHandler,
  verifyReportsPageHandler,
  registerWorkflowTools,
  phase1OrdersModuleHref,
  phase1FinanceModuleHref,
  phase1OrderDetailsModuleHref,
  phase1CustomersModuleHref,
  phase1ReportsModuleHref,
  phase1InvoicesModuleHref,
  setWorkflowCapabilityImporterForTest,
} from '../tools/workflow-tools.js'

describe('workflow-tools', () => {
  let capabilityModules: Map<string, Record<string, unknown>>

  beforeEach(() => {
    capabilityModules = new Map()
    setWorkflowCapabilityImporterForTest(async (moduleHref) => {
      const module = capabilityModules.get(moduleHref)
      if (!module) throw new Error(`Missing test capability module for ${moduleHref}`)
      return module
    })
  })

  function mockCapabilityModule<T extends Record<string, unknown>>(moduleHref: string, module: T): T {
    capabilityModules.set(moduleHref, module)
    return module
  }

  describe('registerCustomerHandler', () => {
    it('returns error when name is missing', async () => {
      const result = await registerCustomerHandler({}, { page: {} })
      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'name is required', retryable: false },
      })
    })

    it('returns error when page is missing from context', async () => {
      const result = await registerCustomerHandler({ name: 'Test' }, {})
      expect(result).toEqual({
        ok: false,
        error: { code: 'missing_context', message: expect.stringContaining('page'), retryable: false },
      })
    })

    it('calls Phase 1 registerCustomer and returns ToolResult on success', async () => {
      const customers = mockCapabilityModule(phase1CustomersModuleHref, {
        registerCustomer: vi.fn().mockResolvedValue({ customerId: '42' }),
      })

      const mockPage = { url: () => 'http://test' }
      const result = await registerCustomerHandler({ name: 'Alex Silva', phone: '5550100' }, { page: mockPage })

      expect(result).toEqual({
        ok: true,
        output: {
          customerId: '42',
          customerName: 'Alex Silva',
          customerPhone: '5550100',
          phone: '5550100',
        },
      })
      expect(customers.registerCustomer).toHaveBeenCalledWith(mockPage, { name: 'Alex Silva', phone: '5550100' })
    })

    it('catches capability errors and returns ToolResult with retryable flag', async () => {
      mockCapabilityModule(phase1CustomersModuleHref, {
        registerCustomer: vi.fn().mockRejectedValue(new Error('Timeout waiting for selector')),
      })

      const result = await registerCustomerHandler({ name: 'Test' }, { page: {} })
      expect(result).toEqual({
        ok: false,
        error: { code: 'capability_error', message: 'Timeout waiting for selector', retryable: true },
      })
    })

    it('recovers customerId when Phase 1 saved but read the URL too early', async () => {
      const customers = mockCapabilityModule(phase1CustomersModuleHref, {
        registerCustomer: vi.fn().mockRejectedValue(new Error(
          'Failed to extract customerId after creating customer "Maria". URL: http://localhost:3012/customers/new/1/',
        )),
        findCustomerByName: vi.fn().mockResolvedValue('77'),
      })

      const mockPage = {
        url: () => 'http://localhost:3012/customers/',
        waitForURL: vi.fn().mockResolvedValue(undefined),
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
      }
      const result = await registerCustomerHandler({ name: 'Maria' }, { page: mockPage })

      expect(result).toEqual({
        ok: true,
        output: {
          customerId: '77',
          customerName: 'Maria',
          customerPhone: null,
          phone: null,
          recoveredFrom: 'customer_id_extraction_failure',
        },
      })
      expect(customers.registerCustomer).toHaveBeenCalledWith(mockPage, { name: 'Maria', phone: undefined })
      expect(customers.findCustomerByName).toHaveBeenCalledWith(mockPage, 'Maria')
    })
  })

  describe('createOrderHandler', () => {
    it('returns error when customerName is missing', async () => {
      const result = await createOrderHandler({}, { page: {} })
      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'customerName is required', retryable: false },
      })
    })

    it('returns error when page is missing', async () => {
      const result = await createOrderHandler({ customerName: 'Test' }, {})
      expect(result).toEqual({
        ok: false,
        error: { code: 'missing_context', message: expect.stringContaining('page'), retryable: false },
      })
    })

    it('calls Phase 1 createOrder and returns ToolResult on success', async () => {
      const orders = mockCapabilityModule(phase1OrdersModuleHref, {
        createOrder: vi.fn().mockResolvedValue({ orderId: '99' }),
      })

      const mockPage = { url: () => 'http://test' }
      const result = await createOrderHandler(
        { customerName: 'Alex Silva', date: '2026-04-15' },
        { page: mockPage },
      )

      expect(result).toEqual({
        ok: true,
        output: {
          orderId: '99',
          customerName: 'Alex Silva',
          orderDate: '2026-04-15',
          orderTime: null,
          orderType: null,
        },
      })
      expect(orders.createOrder).toHaveBeenCalledWith(mockPage, {
        customerName: 'Alex Silva',
        date: '2026-04-15',
        time: undefined,
        type: undefined,
      })
    })

    it('falls back to customerName from artifacts when model sends a generic placeholder', async () => {
      const orders = mockCapabilityModule(phase1OrdersModuleHref, {
        createOrder: vi.fn().mockResolvedValue({ orderId: '100' }),
      })

      const mockPage = { url: () => 'http://test' }
      const result = await createOrderHandler(
        { customerName: 'Customer' },
        { page: mockPage, artifacts: { customerName: 'Phase 2 Customer', orderType: 'standard' } },
      )

      expect(result).toEqual({
        ok: true,
        output: {
          orderId: '100',
          customerName: 'Phase 2 Customer',
          orderDate: null,
          orderTime: null,
          orderType: 'standard',
        },
      })
      expect(orders.createOrder).toHaveBeenCalledWith(mockPage, {
        customerName: 'Phase 2 Customer',
        date: undefined,
        time: undefined,
        type: 'standard',
      })
    })
  })

  describe('openOrderDetailsHandler', () => {
    it('returns error when customerId is missing', async () => {
      const result = await openOrderDetailsHandler({}, { page: {} })
      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'customerId is required', retryable: false },
      })
    })

    it('opens order details using Phase 1 capability', async () => {
      const orderDetails = mockCapabilityModule(phase1OrderDetailsModuleHref, {
        openOrderDetails: vi.fn().mockResolvedValue(undefined),
        fulfillOrder: vi.fn().mockResolvedValue(undefined),
      })

      const mockPage = { url: () => 'http://test' }
      const result = await openOrderDetailsHandler({ customerId: '42', orderId: '99' }, { page: mockPage })

      expect(result).toEqual({
        ok: true,
        output: {
          customerId: '42',
          orderId: '99',
          orderDetailsOpened: true,
        },
      })
      expect(orderDetails.openOrderDetails).toHaveBeenCalledWith(mockPage, '42', '99')
    })
  })

  describe('fulfillOrderHandler', () => {
    it('falls back to artifacts and fulfills the order', async () => {
      const orderDetails = mockCapabilityModule(phase1OrderDetailsModuleHref, {
        openOrderDetails: vi.fn().mockResolvedValue(undefined),
        fulfillOrder: vi.fn().mockResolvedValue(undefined),
      })

      const mockPage = { url: () => 'http://test' }
      const result = await fulfillOrderHandler(
        {},
        { page: mockPage, artifacts: { customerId: '123', orderId: '456' } },
      )

      expect(result).toEqual({
        ok: true,
        output: {
          customerId: '123',
          orderId: '456',
          orderDetailsOpened: true,
          orderFulfilled: true,
        },
      })
      expect(orderDetails.openOrderDetails).toHaveBeenCalledWith(mockPage, '123', '456')
      expect(orderDetails.fulfillOrder).toHaveBeenCalledWith(mockPage)
    })
  })

  describe('findInvoiceByOrderIdHandler', () => {
    it('returns error when orderId is missing', async () => {
      const result = await findInvoiceByOrderIdHandler({}, { page: {} })
      expect(result).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'orderId is required', retryable: false },
      })
    })

    it('returns review output even when no guide exists', async () => {
      mockCapabilityModule(phase1InvoicesModuleHref, {
        findInvoiceByOrderId: vi.fn().mockResolvedValue(null),
      })

      const result = await findInvoiceByOrderIdHandler({}, {
        page: {},
        artifacts: { orderId: 'evt-1' },
      })

      expect(result).toEqual({
        ok: true,
        output: {
          orderId: 'evt-1',
          invoiceReviewed: true,
          invoiceFound: false,
          invoiceId: null,
          invoiceText: null,
        },
      })
    })

    it('returns guide details when a guide is found', async () => {
      mockCapabilityModule(phase1InvoicesModuleHref, {
        findInvoiceByOrderId: vi.fn().mockResolvedValue({
          id: 'guide-1',
          orderId: 'evt-2',
          text: 'Guide row',
        }),
      })

      const result = await findInvoiceByOrderIdHandler({ orderId: 'evt-2' }, { page: {} })

      expect(result).toEqual({
        ok: true,
        output: {
          orderId: 'evt-2',
          invoiceReviewed: true,
          invoiceFound: true,
          invoiceId: 'guide-1',
          invoiceText: 'Guide row',
        },
      })
    })
  })

  describe('verifyFinanceDashboardHandler', () => {
    it('validates finance dashboard successfully', async () => {
      mockCapabilityModule(phase1FinanceModuleHref, {
        openFinanceDashboard: vi.fn().mockResolvedValue(undefined),
        assertDashboardLoaded: vi.fn().mockResolvedValue(undefined),
      })

      const result = await verifyFinanceDashboardHandler({ orderId: 'evt-3' }, { page: {} })

      expect(result).toEqual({
        ok: true,
        output: {
          orderId: 'evt-3',
          financeValidated: true,
        },
      })
    })
  })

  describe('verifyReportsPageHandler', () => {
    it('validates reports page successfully', async () => {
      mockCapabilityModule(phase1ReportsModuleHref, {
        openReportsPage: vi.fn().mockResolvedValue(undefined),
        assertReportsPageLoaded: vi.fn().mockResolvedValue(undefined),
      })

      const result = await verifyReportsPageHandler({ orderId: 'evt-4' }, { page: {} })

      expect(result).toEqual({
        ok: true,
        output: {
          orderId: 'evt-4',
          reportsValidated: true,
        },
      })
    })
  })

  describe('registerWorkflowTools', () => {
    it('registers both tools in the registry', () => {
      const registry = new ToolRegistry()
      registerWorkflowTools(registry)

      expect(registry.has('registerCustomer')).toBe(true)
      expect(registry.has('createOrder')).toBe(true)
      expect(registry.has('openOrderDetails')).toBe(true)
      expect(registry.has('fulfillOrder')).toBe(true)
      expect(registry.has('findInvoiceByOrderId')).toBe(true)
      expect(registry.has('verifyFinanceDashboard')).toBe(true)
      expect(registry.has('verifyReportsPage')).toBe(true)

      const tools = registry.listTools()
      expect(tools).toHaveLength(7)
      expect(tools.every((t) => t.requiresBrowser)).toBe(true)
    })
  })

  describe('integration: execute through registry', () => {
    it('executes registerCustomer through registry with policy check', async () => {
      mockCapabilityModule(phase1CustomersModuleHref, {
        registerCustomer: vi.fn().mockResolvedValue({ customerId: '7' }),
      })

      const registry = new ToolRegistry()
      registerWorkflowTools(registry)

      const result = await registry.execute(
        'registerCustomer',
        { name: 'Maria' },
        { browserAccess: true },
        { page: {} },
      )

      expect(result).toEqual({
        ok: true,
        output: {
          customerId: '7',
          customerName: 'Maria',
          customerPhone: null,
          phone: null,
        },
      })
    })

    it('blocks registerCustomer when browser access denied by policy', async () => {
      const registry = new ToolRegistry()
      registerWorkflowTools(registry)

      const result = await registry.execute(
        'registerCustomer',
        { name: 'Maria' },
        { browserAccess: false },
        { page: {} },
      )

      expect(result).toEqual({
        ok: false,
        error: { code: 'tool_not_allowed', message: expect.any(String), retryable: false },
      })
    })
  })
})
