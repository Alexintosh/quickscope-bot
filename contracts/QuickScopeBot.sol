//SPDX-License-Identifier: MIT
pragma solidity ^0.7.1;

contract QuickScopeBot {

    address private _operator;

    constructor() {
        _operator = msg.sender;
    }

    function quickScope(address uniswapV2RouterAddress, address[] memory path, uint256 amountIn, uint256 amountOutMin, uint256 deadline) public {
        require(_operator == msg.sender, "Unauthorized Action!");
        _transferToMeAndCheckAllowance(path[0], amountIn, uniswapV2RouterAddress);
        IUniswapV2Router(uniswapV2RouterAddress).swapExactTokensForTokens(amountIn, amountOutMin, path, msg.sender, deadline);
        _flush(path, msg.sender);
    }

    function _transferToMeAndCheckAllowance(
        address tokenAddress,
        uint256 value,
        address spender
    ) private {
        IERC20(tokenAddress).transferFrom(msg.sender, address(this), value);
        _checkAllowance(tokenAddress, value, spender);
    }

    function _checkAllowance(
        address tokenAddress,
        uint256 value,
        address spender
    ) private {
        IERC20 token = IERC20(tokenAddress);
        if (token.allowance(address(this), spender) <= value) {
            token.approve(spender, value);
        }
    }

    function _flush(address[] memory tokenAddresses, address receiver) private {
        for(uint256 i = 0; i < tokenAddresses.length; i++) {
            IERC20 token = IERC20(tokenAddresses[i]);
            uint256 balance = token.balanceOf(address(this));
            if(balance > 0) {
                token.transfer(receiver, balance);
            }
        }
        uint256 balance = address(this).balance;
        if(balance > 0) {
            payable(receiver).transfer(balance);
        }
    }
}

interface IUniswapV2Router {
    function WETH() external pure returns (address);
    function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts);
    function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts);
    function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts);
    function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
}