"""core.errors: what a client may see of a caught exception."""
from __future__ import annotations

import smtplib
import socket

import requests
from django.db import DataError
from django.test import SimpleTestCase

from core.errors import GENERIC_ERROR, MAX_LENGTH, NETWORK_ERRORS, exception_text, public_error


class ExceptionTextTests(SimpleTestCase):
    def test_message_argument(self):
        self.assertEqual(exception_text(ValueError("Not a prefix.")), "Not a prefix.")

    def test_first_line_only(self):
        exc = RuntimeError("Line one.\nTraceback (most recent call last):\n  File ...")
        self.assertEqual(exception_text(exc), "Line one.")

    def test_bounded(self):
        text = exception_text(ValueError("x" * (MAX_LENGTH * 2)))
        self.assertEqual(len(text), MAX_LENGTH)
        self.assertTrue(text.endswith("…"))

    def test_oserror_reason_without_the_path(self):
        exc = FileNotFoundError(2, "No such file or directory", "/srv/danbyte/secret/key")
        self.assertEqual(exception_text(exc), "No such file or directory")

    def test_wrapped_exception(self):
        inner = socket.gaierror(-2, "Name or service not known")
        outer = requests.ConnectionError(inner)
        self.assertEqual(exception_text(outer), "Name or service not known")

    def test_no_text(self):
        self.assertEqual(exception_text(KeyError()), "")
        self.assertEqual(exception_text(smtplib.SMTPResponseException(421, b"busy")), "")


class PublicErrorTests(SimpleTestCase):
    def test_expected_keeps_its_message(self):
        exc = requests.ConnectionError("Connection refused")
        self.assertEqual(public_error(exc, "fallback", expected=NETWORK_ERRORS),
                         "Connection refused")

    def test_unexpected_is_logged_and_hidden(self):
        try:
            raise DataError('value too long for type character varying(64) in "api_device"')
        except DataError as exc:
            with self.assertLogs("danbyte.errors", "ERROR") as logs:
                out = public_error(exc, "The value was not saved.", expected=NETWORK_ERRORS)
        self.assertEqual(out, "The value was not saved.")
        self.assertIn("Traceback", logs.output[0])
        self.assertIn("character varying", logs.output[0])

    def test_no_expected_types_means_nothing_is_shown(self):
        with self.assertLogs("danbyte.errors", "ERROR"):
            self.assertEqual(public_error(ValueError("internal")), GENERIC_ERROR)

    def test_log_false_stays_quiet(self):
        with self.assertNoLogs("danbyte.errors"):
            self.assertEqual(public_error(KeyError("k"), "fallback", log=False), "fallback")

    def test_expected_without_text_falls_back(self):
        self.assertEqual(public_error(OSError(), "Unreachable.", expected=OSError), "Unreachable.")


class SmtpErrorTextTests(SimpleTestCase):
    """The SMTP test endpoints' wording runs on the same rules."""

    def test_server_reply(self):
        from core.email import describe_smtp_error, smtp_error_text

        exc = smtplib.SMTPAuthenticationError(535, b"5.7.8 Username and Password not accepted")
        self.assertEqual(smtp_error_text(exc), "5.7.8 Username and Password not accepted")
        self.assertIn("rejected the login", describe_smtp_error(exc))

    def test_refused_recipient(self):
        from core.email import describe_smtp_error

        exc = smtplib.SMTPRecipientsRefused({"x@example.test": (550, b"5.1.1 No such user")})
        self.assertIn("rejected the recipient (550)", describe_smtp_error(exc))
        self.assertIn("No such user", describe_smtp_error(exc))

    def test_unexpected_is_not_echoed(self):
        from core.email import describe_smtp_error, smtp_error_text

        exc = AttributeError("'NoneType' object has no attribute 'email_host'")
        self.assertEqual(smtp_error_text(exc), "")
        with self.assertLogs("danbyte.errors", "ERROR"):
            self.assertNotIn("NoneType", describe_smtp_error(exc))
