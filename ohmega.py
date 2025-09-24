#!/usr/bin/env python3
"""
oHmMega CLI - A command-line interface for oHmMega
"""

import argparse
import sys
from typing import List, Optional

__version__ = "1.0.0"


def create_parser() -> argparse.ArgumentParser:
    """Create and configure the argument parser."""
    parser = argparse.ArgumentParser(
        prog="ohmega",
        description="oHmMega - A versatile command-line tool",
        epilog="For more information, visit: https://github.com/EU-UNION-AI-PACT/oHmMega"
    )
    
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}"
    )
    
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose output"
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Available commands")
    
    # Info command
    info_parser = subparsers.add_parser("info", help="Display information about oHmMega")
    info_parser.add_argument(
        "--format",
        choices=["text", "json"],
        default="text",
        help="Output format (default: text)"
    )
    
    # Process command
    process_parser = subparsers.add_parser("process", help="Process data or files")
    process_parser.add_argument(
        "input",
        nargs="?",
        help="Input data or file path"
    )
    process_parser.add_argument(
        "-o", "--output",
        help="Output file path"
    )
    
    return parser


def cmd_info(args) -> int:
    """Handle the info command."""
    info_data = {
        "name": "oHmMega",
        "version": __version__,
        "description": "A versatile command-line tool",
        "repository": "https://github.com/EU-UNION-AI-PACT/oHmMega"
    }
    
    if args.format == "json":
        import json
        print(json.dumps(info_data, indent=2))
    else:
        print(f"Name: {info_data['name']}")
        print(f"Version: {info_data['version']}")
        print(f"Description: {info_data['description']}")
        print(f"Repository: {info_data['repository']}")
    
    return 0


def cmd_process(args) -> int:
    """Handle the process command."""
    if args.verbose:
        print(f"Processing with verbose mode enabled")
    
    input_data = args.input or "No input provided"
    
    if args.verbose:
        print(f"Input: {input_data}")
        if args.output:
            print(f"Output will be written to: {args.output}")
    
    # Simple processing logic
    processed_result = f"Processed: {input_data}"
    
    if args.output:
        try:
            with open(args.output, 'w') as f:
                f.write(processed_result + '\n')
            print(f"Result written to {args.output}")
        except IOError as e:
            print(f"Error writing to {args.output}: {e}", file=sys.stderr)
            return 1
    else:
        print(processed_result)
    
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    """Main entry point for the CLI."""
    parser = create_parser()
    args = parser.parse_args(argv)
    
    if args.verbose:
        print(f"oHmMega CLI v{__version__}")
        print(f"Running command: {args.command}")
    
    # Handle commands
    if args.command == "info":
        return cmd_info(args)
    elif args.command == "process":
        return cmd_process(args)
    else:
        parser.print_help()
        return 0


if __name__ == "__main__":
    sys.exit(main())