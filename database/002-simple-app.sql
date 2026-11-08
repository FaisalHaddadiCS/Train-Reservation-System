BEGIN;

ALTER TABLE public.tickets
    ADD COLUMN IF NOT EXISTS "bookedPrice" NUMERIC(10, 2);

UPDATE public.tickets AS t
SET "bookedPrice" = tr.price
FROM public.trains AS tr
WHERE t."trainID" = tr."trainID"
  AND t."bookedPrice" IS NULL;

ALTER TABLE public.tickets
    ALTER COLUMN "bookedPrice" SET NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    public.trains, public.passengers, public.passenger_users,
    public.staff_users, public.tickets
TO service_role;

GRANT USAGE, SELECT ON SEQUENCE
    public.passenger_users_id_seq,
    public.staff_users_id_seq,
    public."tickets_ticketNumber_seq"
TO service_role;

CREATE OR REPLACE FUNCTION public.app_register_passenger(
    p_username TEXT, p_email TEXT, p_password TEXT,
    p_passenger_id TEXT, p_name TEXT, p_contact TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.passengers ("passengerID", name, "contactNumber")
    VALUES (p_passenger_id, p_name, p_contact);

    INSERT INTO public.passenger_users (
        username, email, password, "passengerID", name, "contactNumber"
    ) VALUES (
        p_username, p_email, p_password, p_passenger_id, p_name, p_contact
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.app_book(
    p_train_id TEXT, p_passenger_id TEXT, p_name TEXT,
    p_contact TEXT, p_payment TEXT, p_count INTEGER
)
RETURNS INTEGER[]
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    selected_train public.trains%ROWTYPE;
    ticket_ids INTEGER[];
BEGIN
    IF p_count IS NULL OR p_count < 1 OR p_count > 20 THEN
        RAISE EXCEPTION 'Number of tickets must be between 1 and 20.';
    END IF;

    IF p_payment IS NULL OR p_payment NOT IN ('Cash at Station', 'Credit Card') THEN
        RAISE EXCEPTION 'Invalid payment method.';
    END IF;

    IF NULLIF(trim(p_passenger_id), '') IS NULL
        OR NULLIF(trim(p_name), '') IS NULL
        OR NULLIF(trim(p_contact), '') IS NULL THEN
        RAISE EXCEPTION 'Passenger details are required.';
    END IF;

    SELECT * INTO selected_train
    FROM public.trains
    WHERE "trainID" = p_train_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Train not found.';
    END IF;

    IF selected_train.status = 'Cancelled'
        OR selected_train."departureDate" < (now() AT TIME ZONE 'Asia/Riyadh')::date THEN
        RAISE EXCEPTION 'This train is unavailable for booking.';
    END IF;

    IF selected_train."availableSeats" < p_count THEN
        RAISE EXCEPTION 'Not enough seats available. Refresh schedules.';
    END IF;

    INSERT INTO public.passengers ("passengerID", name, "contactNumber")
    VALUES (p_passenger_id, p_name, p_contact)
    ON CONFLICT ("passengerID") DO NOTHING;

    WITH inserted AS (
        INSERT INTO public.tickets (
            "passengerID", "trainID", "paymentMethod", status, "bookedPrice"
        )
        SELECT p_passenger_id, p_train_id, p_payment, 'Pending', selected_train.price
        FROM generate_series(1, p_count)
        RETURNING "ticketNumber"
    )
    SELECT array_agg("ticketNumber" ORDER BY "ticketNumber")
    INTO ticket_ids FROM inserted;

    UPDATE public.trains
    SET "availableSeats" = "availableSeats" - p_count
    WHERE "trainID" = p_train_id;

    RETURN ticket_ids;
END;
$$;

CREATE OR REPLACE FUNCTION public.app_cancel_ticket(p_ticket_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    selected_ticket public.tickets%ROWTYPE;
BEGIN
    SELECT * INTO selected_ticket
    FROM public.tickets
    WHERE "ticketNumber" = p_ticket_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Ticket not found.';
    END IF;

    IF selected_ticket.status = 'Cancelled' THEN
        RETURN;
    END IF;

    UPDATE public.trains
    SET "availableSeats" = "availableSeats" + 1
    WHERE "trainID" = selected_ticket."trainID";

    UPDATE public.tickets
    SET status = 'Cancelled'
    WHERE "ticketNumber" = p_ticket_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.app_update_train(
    p_train_id TEXT, p_price NUMERIC, p_status TEXT,
    p_date DATE, p_time TEXT, p_capacity INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    selected_train public.trains%ROWTYPE;
    occupied INTEGER;
BEGIN
    IF p_price IS NULL OR p_price < 0
        OR p_capacity IS NULL OR p_capacity < 1 OR p_capacity > 100000
        OR p_status IS NULL OR p_status NOT IN ('On Time', 'Delayed', 'Cancelled')
        OR p_date IS NULL OR p_date < (now() AT TIME ZONE 'Asia/Riyadh')::date
        OR p_time IS NULL OR p_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        RAISE EXCEPTION 'Invalid train details.';
    END IF;

    SELECT * INTO selected_train
    FROM public.trains
    WHERE "trainID" = p_train_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Train not found.';
    END IF;

    occupied := selected_train."totalCapacity" - selected_train."availableSeats";
    IF p_capacity < occupied THEN
        RAISE EXCEPTION 'Capacity cannot be below the current booked seats.';
    END IF;

    UPDATE public.trains
    SET price = p_price,
        status = p_status,
        "departureDate" = p_date,
        departuretime = p_time,
        "totalCapacity" = p_capacity,
        "availableSeats" = p_capacity - occupied
    WHERE "trainID" = p_train_id;
END;
$$;

REVOKE ALL ON FUNCTION
    public.app_register_passenger(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT),
    public.app_book(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER),
    public.app_cancel_ticket(INTEGER),
    public.app_update_train(TEXT, NUMERIC, TEXT, DATE, TEXT, INTEGER)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.app_register_passenger(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT),
    public.app_book(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER),
    public.app_cancel_ticket(INTEGER),
    public.app_update_train(TEXT, NUMERIC, TEXT, DATE, TEXT, INTEGER)
TO service_role;

COMMIT;
