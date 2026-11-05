/** Shared payment words and whether payment is still possible. */
export function paymentState(invoice) {
  const paid = ['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'].includes(invoice.status)
  const closed = paid || ['CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'VOIDED', 'DELETED'].includes(invoice.status)
  const label = paid ? 'Paid' : invoice.status === 'PARTIALLY_PAID' ? `Part paid, ${Number(invoice.due).toFixed(2)} left`
    : invoice.status === 'PARTIALLY_REFUNDED' ? (invoice.refunded != null ? `Part refunded, ${Number(invoice.refunded).toFixed(2)} returned` : 'Part refunded. Check refund details.')
    : ({ CANCELLED: 'Invoice cancelled', REFUNDED: 'Refunded', VOIDED: 'Invoice cancelled', DELETED: 'Invoice cancelled' }[invoice.status] || 'Waiting for payment')
  return { paid, closed, label }
}
