/* tslint:disable:no-non-null-assertion */
import gql from 'graphql-tag';
import path from 'path';

import { StockMovementType } from '../../common/lib/generated-types';
import { pick } from '../../common/lib/pick';
import { ID } from '../../common/lib/shared-types';
import { PaymentMethodHandler } from '../src/config/payment-method/payment-method-handler';

import { TEST_SETUP_TIMEOUT_MS } from './config/test-config';
import { ORDER_FRAGMENT, ORDER_WITH_LINES_FRAGMENT } from './graphql/fragments';
import {
    CancelOrder,
    CreateFulfillment,
    GetCustomerList,
    GetOrder,
    GetOrderFulfillmentItems,
    GetOrderFulfillments,
    GetOrderList,
    GetOrderListFulfillments,
    GetProductWithVariants,
    GetStockMovement,
    OrderItemFragment,
    SettlePayment,
    UpdateProductVariants,
} from './graphql/generated-e2e-admin-types';
import {
    AddItemToOrder,
    AddPaymentToOrder,
    GetShippingMethods,
    SetShippingAddress,
    SetShippingMethod,
    TransitionToState,
} from './graphql/generated-e2e-shop-types';
import { GET_CUSTOMER_LIST, GET_PRODUCT_WITH_VARIANTS, GET_STOCK_MOVEMENT, UPDATE_PRODUCT_VARIANTS, } from './graphql/shared-definitions';
import {
    ADD_ITEM_TO_ORDER,
    ADD_PAYMENT,
    GET_ELIGIBLE_SHIPPING_METHODS,
    SET_SHIPPING_ADDRESS,
    SET_SHIPPING_METHOD,
    TRANSITION_TO_STATE,
} from './graphql/shop-definitions';
import { TestAdminClient, TestShopClient } from './test-client';
import { TestServer } from './test-server';
import { assertThrowsWithMessage } from './utils/assert-throws-with-message';

describe('Orders resolver', () => {
    const adminClient = new TestAdminClient();
    const shopClient = new TestShopClient();
    const server = new TestServer();
    let customers: GetCustomerList.Items[];
    const password = 'test';

    beforeAll(async () => {
        const token = await server.init(
            {
                productsCsvPath: path.join(__dirname, 'fixtures/e2e-products-full.csv'),
                customerCount: 2,
            },
            {
                paymentOptions: {
                    paymentMethodHandlers: [twoStagePaymentMethod, failsToSettlePaymentMethod],
                },
            },
        );
        await adminClient.init();

        // Create a couple of orders to be queried
        const result = await adminClient.query<GetCustomerList.Query, GetCustomerList.Variables>(
            GET_CUSTOMER_LIST,
            {
                options: {
                    take: 2,
                },
            },
        );
        customers = result.customers.items;
        await shopClient.asUserWithCredentials(customers[0].emailAddress, password);
        await shopClient.query<AddItemToOrder.Mutation, AddItemToOrder.Variables>(ADD_ITEM_TO_ORDER, {
            productVariantId: 'T_1',
            quantity: 1,
        });
        await shopClient.query<AddItemToOrder.Mutation, AddItemToOrder.Variables>(ADD_ITEM_TO_ORDER, {
            productVariantId: 'T_2',
            quantity: 1,
        });
        await shopClient.asUserWithCredentials(customers[1].emailAddress, password);
        await shopClient.query<AddItemToOrder.Mutation, AddItemToOrder.Variables>(ADD_ITEM_TO_ORDER, {
            productVariantId: 'T_2',
            quantity: 1,
        });
        await shopClient.query<AddItemToOrder.Mutation, AddItemToOrder.Variables>(ADD_ITEM_TO_ORDER, {
            productVariantId: 'T_3',
            quantity: 3,
        });
    }, TEST_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await server.destroy();
    });

    it('orders', async () => {
        const result = await adminClient.query<GetOrderList.Query>(GET_ORDERS_LIST);
        expect(result.orders.items.map(o => o.id)).toEqual(['T_1', 'T_2']);
    });

    it('order', async () => {
        const result = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, { id: 'T_2' });
        expect(result.order!.id).toBe('T_2');
    });

    describe('payments', () => {
        it('settlePayment fails', async () => {
            await shopClient.asUserWithCredentials(customers[0].emailAddress, password);
            await proceedToArrangingPayment(shopClient);

            const { addPaymentToOrder } = await shopClient.query<
                AddPaymentToOrder.Mutation,
                AddPaymentToOrder.Variables
            >(ADD_PAYMENT, {
                input: {
                    method: failsToSettlePaymentMethod.code,
                    metadata: {
                        baz: 'quux',
                    },
                },
            });
            const order = addPaymentToOrder!;

            expect(order.state).toBe('PaymentAuthorized');

            const payment = order.payments![0];
            const { settlePayment } = await adminClient.query<
                SettlePayment.Mutation,
                SettlePayment.Variables
            >(SETTLE_PAYMENT, {
                id: payment.id,
            });

            expect(settlePayment!.id).toBe(payment.id);
            expect(settlePayment!.state).toBe('Authorized');

            const result = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                id: order.id,
            });

            expect(result.order!.state).toBe('PaymentAuthorized');
        });

        it('settlePayment succeeds', async () => {
            await shopClient.asUserWithCredentials(customers[1].emailAddress, password);
            await proceedToArrangingPayment(shopClient);

            const { addPaymentToOrder } = await shopClient.query<
                AddPaymentToOrder.Mutation,
                AddPaymentToOrder.Variables
            >(ADD_PAYMENT, {
                input: {
                    method: twoStagePaymentMethod.code,
                    metadata: {
                        baz: 'quux',
                    },
                },
            });
            const order = addPaymentToOrder!;

            expect(order.state).toBe('PaymentAuthorized');

            const payment = order.payments![0];
            const { settlePayment } = await adminClient.query<
                SettlePayment.Mutation,
                SettlePayment.Variables
            >(SETTLE_PAYMENT, {
                id: payment.id,
            });

            expect(settlePayment!.id).toBe(payment.id);
            expect(settlePayment!.state).toBe('Settled');
            // further metadata is combined into existing object
            expect(settlePayment!.metadata).toEqual({
                baz: 'quux',
                moreData: 42,
            });

            const result = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                id: order.id,
            });

            expect(result.order!.state).toBe('PaymentSettled');
            expect(result.order!.payments![0].state).toBe('Settled');
        });
    });

    describe('fulfillment', () => {
        it(
            'throws if Order is not in "PaymentSettled" state',
            assertThrowsWithMessage(async () => {
                const { order } = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                    id: 'T_1',
                });
                expect(order!.state).toBe('PaymentAuthorized');

                await adminClient.query<CreateFulfillment.Mutation, CreateFulfillment.Variables>(
                    CREATE_FULFILLMENT,
                    {
                        input: {
                            lines: order!.lines.map(l => ({ orderLineId: l.id, quantity: l.quantity })),
                            method: 'Test',
                        },
                    },
                );
            }, 'One or more OrderItems belong to an Order which is in an invalid state'),
        );

        it(
            'throws if lines is empty',
            assertThrowsWithMessage(async () => {
                const { order } = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                    id: 'T_2',
                });
                expect(order!.state).toBe('PaymentSettled');
                await adminClient.query<CreateFulfillment.Mutation, CreateFulfillment.Variables>(
                    CREATE_FULFILLMENT,
                    {
                        input: {
                            lines: [],
                            method: 'Test',
                        },
                    },
                );
            }, 'Nothing to fulfill'),
        );

        it(
            'throws if all quantities are zero',
            assertThrowsWithMessage(async () => {
                const { order } = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                    id: 'T_2',
                });
                expect(order!.state).toBe('PaymentSettled');
                await adminClient.query<CreateFulfillment.Mutation, CreateFulfillment.Variables>(
                    CREATE_FULFILLMENT,
                    {
                        input: {
                            lines: order!.lines.map(l => ({ orderLineId: l.id, quantity: 0 })),
                            method: 'Test',
                        },
                    },
                );
            }, 'Nothing to fulfill'),
        );

        it('creates a partial fulfillment', async () => {
            const { order } = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                id: 'T_2',
            });
            expect(order!.state).toBe('PaymentSettled');
            const lines = order!.lines;

            const { createFulfillment } = await adminClient.query<
                CreateFulfillment.Mutation,
                CreateFulfillment.Variables
            >(CREATE_FULFILLMENT, {
                input: {
                    lines: lines.map(l => ({ orderLineId: l.id, quantity: 1 })),
                    method: 'Test1',
                    trackingCode: '111',
                },
            });

            expect(createFulfillment!.method).toBe('Test1');
            expect(createFulfillment!.trackingCode).toBe('111');
            expect(createFulfillment!.orderItems).toEqual([
                { id: lines[0].items[0].id },
                { id: lines[1].items[0].id },
            ]);

            const result = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                id: 'T_2',
            });

            expect(result.order!.state).toBe('PartiallyFulfilled');
            expect(result.order!.lines[0].items[0].fulfillment!.id).toBe(createFulfillment!.id);
            expect(result.order!.lines[1].items[2].fulfillment!.id).toBe(createFulfillment!.id);
            expect(result.order!.lines[1].items[1].fulfillment).toBeNull();
            expect(result.order!.lines[1].items[0].fulfillment).toBeNull();
        });

        it('creates a second partial fulfillment', async () => {
            const { order } = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                id: 'T_2',
            });
            expect(order!.state).toBe('PartiallyFulfilled');
            const lines = order!.lines;

            const { createFulfillment } = await adminClient.query<
                CreateFulfillment.Mutation,
                CreateFulfillment.Variables
            >(CREATE_FULFILLMENT, {
                input: {
                    lines: [{ orderLineId: lines[1].id, quantity: 1 }],
                    method: 'Test2',
                    trackingCode: '222',
                },
            });

            const result = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                id: 'T_2',
            });
            // expect(result.order!.lines).toEqual({});
            expect(result.order!.state).toBe('PartiallyFulfilled');
            expect(result.order!.lines[1].items[2].fulfillment).not.toBeNull();
            expect(result.order!.lines[1].items[1].fulfillment).not.toBeNull();
            expect(result.order!.lines[1].items[0].fulfillment).toBeNull();
        });

        it(
            'throws if an OrderItem already part of a Fulfillment',
            assertThrowsWithMessage(async () => {
                const { order } = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                    id: 'T_2',
                });
                expect(order!.state).toBe('PartiallyFulfilled');
                await adminClient.query<CreateFulfillment.Mutation, CreateFulfillment.Variables>(
                    CREATE_FULFILLMENT,
                    {
                        input: {
                            method: 'Test',
                            lines: [
                                {
                                    orderLineId: order!.lines[0].id,
                                    quantity: 1,
                                },
                            ],
                        },
                    },
                );
            }, 'One or more OrderItems have already been fulfilled'),
        );

        it('completes fulfillment', async () => {
            const { order } = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                id: 'T_2',
            });
            expect(order!.state).toBe('PartiallyFulfilled');

            const orderItems = order!.lines.reduce(
                (items, line) => [...items, ...line.items],
                [] as OrderItemFragment[],
            );

            const { createFulfillment } = await adminClient.query<
                CreateFulfillment.Mutation,
                CreateFulfillment.Variables
            >(CREATE_FULFILLMENT, {
                input: {
                    lines: [
                        {
                            orderLineId: order!.lines[1].id,
                            quantity: 1,
                        },
                    ],
                    method: 'Test3',
                    trackingCode: '333',
                },
            });

            expect(createFulfillment!.method).toBe('Test3');
            expect(createFulfillment!.trackingCode).toBe('333');
            expect(createFulfillment!.orderItems).toEqual([{ id: orderItems[1].id }]);

            const result = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                id: 'T_2',
            });
            expect(result.order!.state).toBe('Fulfilled');
        });

        it('order.fullfillments resolver for single order', async () => {
            const { order } = await adminClient.query<
                GetOrderFulfillments.Query,
                GetOrderFulfillments.Variables
            >(GET_ORDER_FULFILLMENTS, {
                id: 'T_2',
            });

            expect(order!.fulfillments).toEqual([
                { id: 'T_1', method: 'Test1' },
                { id: 'T_2', method: 'Test2' },
                { id: 'T_3', method: 'Test3' },
            ]);
        });

        it('order.fullfillments resolver for order list', async () => {
            const { orders } = await adminClient.query<GetOrderListFulfillments.Query>(
                GET_ORDER_LIST_FULFILLMENTS,
            );

            expect(orders.items[0].fulfillments).toEqual([]);
            expect(orders.items[1].fulfillments).toEqual([
                { id: 'T_1', method: 'Test1' },
                { id: 'T_2', method: 'Test2' },
                { id: 'T_3', method: 'Test3' },
            ]);
        });

        it('order.fullfillments.orderItems resolver', async () => {
            const { order } = await adminClient.query<
                GetOrderFulfillmentItems.Query,
                GetOrderFulfillmentItems.Variables
            >(GET_ORDER_FULFILLMENT_ITEMS, {
                id: 'T_2',
            });

            expect(order!.fulfillments![0].orderItems).toEqual([{ id: 'T_3' }, { id: 'T_4' }]);
            expect(order!.fulfillments![1].orderItems).toEqual([{ id: 'T_5' }]);
        });
    });

    describe('cancellation', () => {
        let orderId: string;
        let product: GetProductWithVariants.Product;
        let productVariantId: string;

        beforeAll(async () => {
            const result = await adminClient.query<
                GetProductWithVariants.Query,
                GetProductWithVariants.Variables
            >(GET_PRODUCT_WITH_VARIANTS, {
                id: 'T_3',
            });
            product = result.product!;
            productVariantId = product.variants[0].id;

            // Set the ProductVariant to trackInventory
            const { updateProductVariants } = await adminClient.query<
                UpdateProductVariants.Mutation,
                UpdateProductVariants.Variables
            >(UPDATE_PRODUCT_VARIANTS, {
                input: [
                    {
                        id: productVariantId,
                        trackInventory: true,
                    },
                ],
            });

            // Add the ProductVariant to the Order
            await shopClient.asUserWithCredentials(customers[0].emailAddress, password);
            const { addItemToOrder } = await shopClient.query<
                AddItemToOrder.Mutation,
                AddItemToOrder.Variables
            >(ADD_ITEM_TO_ORDER, {
                productVariantId,
                quantity: 1,
            });
            orderId = addItemToOrder!.id;
        });

        it(
            'cannot cancel from AddingItems state',
            assertThrowsWithMessage(async () => {
                const { order } = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                    id: orderId,
                });
                expect(order!.state).toBe('AddingItems');
                await adminClient.query<CancelOrder.Mutation, CancelOrder.Variables>(CANCEL_ORDER, {
                    id: orderId,
                });
            }, 'Cannot transition Order from "AddingItems" to "Cancelled"'),
        );

        it(
            'cannot cancel from ArrangingPayment state',
            assertThrowsWithMessage(async () => {
                await proceedToArrangingPayment(shopClient);
                const { order } = await adminClient.query<GetOrder.Query, GetOrder.Variables>(GET_ORDER, {
                    id: orderId,
                });
                expect(order!.state).toBe('ArrangingPayment');
                await adminClient.query<CancelOrder.Mutation, CancelOrder.Variables>(CANCEL_ORDER, {
                    id: orderId,
                });
            }, 'Cannot transition Order from "ArrangingPayment" to "Cancelled"'),
        );

        it('reallocates stock back in', async () => {
            const { addPaymentToOrder } = await shopClient.query<
                AddPaymentToOrder.Mutation,
                AddPaymentToOrder.Variables
            >(ADD_PAYMENT, {
                input: {
                    method: twoStagePaymentMethod.code,
                    metadata: {
                        baz: 'quux',
                    },
                },
            });

            expect(addPaymentToOrder!.state).toBe('PaymentAuthorized');

            const result1 = await adminClient.query<GetStockMovement.Query, GetStockMovement.Variables>(
                GET_STOCK_MOVEMENT,
                {
                    id: product.id,
                },
            );
            const variant1 = result1.product!.variants[0];
            expect(variant1.stockOnHand).toBe(99);
            expect(variant1.stockMovements.items.map(pick(['type', 'quantity']))).toEqual([
                { type: StockMovementType.ADJUSTMENT, quantity: 100 },
                { type: StockMovementType.SALE, quantity: -1 },
            ]);

            const { cancelOrder } = await adminClient.query<CancelOrder.Mutation, CancelOrder.Variables>(CANCEL_ORDER, {
                id: orderId,
            });

            expect(cancelOrder!.state).toBe('Cancelled');

            const result2 = await adminClient.query<GetStockMovement.Query, GetStockMovement.Variables>(
                GET_STOCK_MOVEMENT,
                {
                    id: product.id,
                },
            );
            const variant2 = result2.product!.variants[0];
            expect(variant2.stockOnHand).toBe(100);
            expect(variant2.stockMovements.items.map(pick(['type', 'quantity']))).toEqual([
                { type: StockMovementType.ADJUSTMENT, quantity: 100 },
                { type: StockMovementType.SALE, quantity: -1 },
                { type: StockMovementType.CANCELLATION, quantity: 1 },
            ]);
        });
    });
});

/**
 * A two-stage (authorize, capture) payment method.
 */
const twoStagePaymentMethod = new PaymentMethodHandler({
    code: 'authorize-only-payment-method',
    description: 'Test Payment Method',
    args: {},
    createPayment: (order, args, metadata) => {
        return {
            amount: order.total,
            state: 'Authorized',
            transactionId: '12345',
            metadata,
        };
    },
    settlePayment: () => {
        return {
            success: true,
            metadata: {
                moreData: 42,
            },
        };
    },
});

/**
 * A payment method where calling `settlePayment` always fails.
 */
const failsToSettlePaymentMethod = new PaymentMethodHandler({
    code: 'fails-to-settle-payment-method',
    description: 'Test Payment Method',
    args: {},
    createPayment: (order, args, metadata) => {
        return {
            amount: order.total,
            state: 'Authorized',
            transactionId: '12345',
            metadata,
        };
    },
    settlePayment: () => {
        return {
            success: false,
            errorMessage: 'Something went horribly wrong',
        };
    },
});

async function proceedToArrangingPayment(shopClient: TestShopClient): Promise<ID> {
    await shopClient.query<SetShippingAddress.Mutation, SetShippingAddress.Variables>(SET_SHIPPING_ADDRESS, {
        input: {
            fullName: 'name',
            streetLine1: '12 the street',
            city: 'foo',
            postalCode: '123456',
            countryCode: 'US',
        },
    });

    const { eligibleShippingMethods } = await shopClient.query<GetShippingMethods.Query>(
        GET_ELIGIBLE_SHIPPING_METHODS,
    );

    await shopClient.query<SetShippingMethod.Mutation, SetShippingMethod.Variables>(SET_SHIPPING_METHOD, {
        id: eligibleShippingMethods[1].id,
    });

    const { transitionOrderToState } = await shopClient.query<
        TransitionToState.Mutation,
        TransitionToState.Variables
    >(TRANSITION_TO_STATE, { state: 'ArrangingPayment' });

    return transitionOrderToState!.id;
}

export const GET_ORDERS_LIST = gql`
    query GetOrderList($options: OrderListOptions) {
        orders(options: $options) {
            items {
                ...Order
            }
            totalItems
        }
    }
    ${ORDER_FRAGMENT}
`;

export const GET_ORDER = gql`
    query GetOrder($id: ID!) {
        order(id: $id) {
            ...OrderWithLines
        }
    }
    ${ORDER_WITH_LINES_FRAGMENT}
`;

export const SETTLE_PAYMENT = gql`
    mutation SettlePayment($id: ID!) {
        settlePayment(id: $id) {
            id
            state
            metadata
        }
    }
`;

export const CREATE_FULFILLMENT = gql`
    mutation CreateFulfillment($input: CreateFulfillmentInput!) {
        createFulfillment(input: $input) {
            id
            method
            trackingCode
            orderItems {
                id
            }
        }
    }
`;

export const GET_ORDER_FULFILLMENTS = gql`
    query GetOrderFulfillments($id: ID!) {
        order(id: $id) {
            id
            fulfillments {
                id
                method
            }
        }
    }
`;

export const GET_ORDER_LIST_FULFILLMENTS = gql`
    query GetOrderListFulfillments {
        orders {
            items {
                id
                fulfillments {
                    id
                    method
                }
            }
        }
    }
`;

export const GET_ORDER_FULFILLMENT_ITEMS = gql`
    query GetOrderFulfillmentItems($id: ID!) {
        order(id: $id) {
            id
            fulfillments {
                id
                orderItems {
                    id
                }
            }
        }
    }
`;

export const CANCEL_ORDER = gql`
    mutation CancelOrder($id: ID!) {
        cancelOrder(id: $id) {
            id
            state
            active
        }
    }
`;
